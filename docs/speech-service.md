# FunASR / OmniVoice 本机语音服务

## 安装

在 Windows 运行 `npm run setup:speech`。创建独立的 `InnoTechx-Speech` Ubuntu 24.04 WSL2 发行版，使用 Windows 已安装的 NVIDIA 驱动。无需修改 Docker。安装器核验官方 Ubuntu rootfs SHA256，只安装 Linux CUDA 编译器/运行头文件，不安装 Linux GPU 驱动。

Windows 配置与启动日志：`%LOCALAPPDATA%/com.innotechx.digitalhuman.live/speech/{runtime.json,voice.json,server.log}`。Linux 环境：`/opt/innotechx-speech`。`tts` 和 `asr` 是两个独立 venv，分别解决 OmniVoice 的 transformers 5 与 FunASR 的 transformers 4 依赖。

OmniVoice 官方源码固定 `08be0b4ccbac3e13e374e86fbfead4b4cac343e2`，加载 `k2-fsa/OmniVoice` 及其自带的 audio_tokenizer。权重默认从同一发布者的 ModelScope 仓库下载，并校验主模型和 audio_tokenizer 的 SHA256 与 HF checkpoint 一致。可用 `setup-speech.ps1 -ModelSource huggingface -HfEndpoint https://huggingface.co` 切换下载源。PyPI 0.2.1 wheel 不含 `omnivoice_flashinfer`，不能用它代替官方源码安装。FlashInfer 固定 `0.6.15.post1`。默认使用 CUDA 12.8 编译本机所需内核；可用 `setup-speech.ps1 -PrecompiledCache` 安装匹配的约1.3GB预编译缓存。启动调用 `apply_flashinfer` 启用 CUDA Graph，采用有限的时长桶限制图缓存增长，并执行真实 warmup；检查 attention implementation、CUDA Graph 缓存和非空波形后才报告已验证。

FunASR 使用带模型时间戳的中文 Paraformer（iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch）、FSMN VAD 和 CT 标点模型，由 ModelScope 官方 iic 仓库下载。为 TTS 留出显存，ASR 默认在 CPU 运行。

## 接口

基础地址 `http://127.0.0.1:8766`，地址不带 `/v1`、`/api`。服务只监听 WSL2 loopback，Windows 通过 localhost forwarding 访问。

`POST /api/stt`：

```json
{"audio":"BASE64_PCM","sample_rate":16000,"format":"pcm_s16le","request_id":"capture-id"}
```

音频必须为单声道16kHz s16le，0.1～25秒。歌曲转录可传 `{"audio_path":"G:\\音乐\\歌曲.mp3"}`，由服务解码，最长30分钟、100MB。识别返回 `text`、`segments: [{start_ms,end_ms,text}]`、词级 `timestamps`、`timestamp_source`、`inference_ms`、设备和模型。无声音时返回空 segments。CPU worker 串行处理，忙碌时返回429，避免积压旧录音。

`POST /api/tts`：

```json
{"model":"k2-fsa/OmniVoice","input":"你好，欢迎来到直播间。","ref_audio":"G:\\声音\\参考.wav","ref_text":"参考录音里完整的原话。","request_id":"reply-id"}
```

返回裸24kHz、单声道、16位小端 PCM；HTTP 响应头必须带 `X-Audio-Sample-Rate: 24000`、`X-Audio-Channels: 1`、`X-Audio-Format: s16le`。单句最多200字、60秒；应用通常按100字或句末切分。参考录音通过 `/mnt/<盘符>/...` 在 WSL 读取，缓存最多两个参考提示，文件更新时失效。参考文字必填，不加载 OmniVoice 内置 Whisper。

`POST /api/tts/cancel`：`{"request_id":"reply-id"}`，取消整个回答（包括排队的句子）。取消检查放在每个 diffusion step 的 `_predict_tokens_with_scoring`，覆盖 FlashInfer CUDA Graph 路径。正在执行的单个 CUDA kernel 结束后检查，不声称能瞬时抢占 GPU。

`GET /health`：返回 `backend`、`ready`、TTS 模型/设备、`stt.ready`、`acceleration.{flashinfer,cuda_graph,verified,gpu}` 和初始化错误。安装包存在不等于实际加速成功。应用只有在两个模型和加速验证全部通过后才允许开始数字人会话。

## 生命周期与迁移

软件可在模型加载、试听、播报期间关闭服务。Linux 控制器记录 PID、`/proc` 启动时间和完整 cmdline，在锁内创建/停止实例；只对身份吻合的进程组发送 TERM/KILL。关闭 Windows `wsl.exe` 启动器之前先清理 Linux 进程，防止显存残留。软件退出只关闭自己启动的实例；终端启动实例也可通过界面显式关闭。控制器不终止整个 WSL 发行版。

前端将旧 `qwen3-tts-config` 中的参考路径和文字迁移到 `speech-service-config-v1`，采用 OmniVoice 模型及新基础地址。旧 `voice.json` 可提供首用预设，不覆盖用户已保存录音。旧模型文件保留。切换时只允许停止本软件旧 Qwen 的精确解释器/脚本进程；不会按端口盲目杀进程。

启动/关闭服务会暂停自动回答和麦克风；已经部分播报的队列项转为人工确认。原歌曲 PCM 播放独立于 TTS。句子流水线、开口打断、字幕和 Vidu PCM 格式校验沿用组件版实现。

## 验证

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
wsl -d InnoTechx-Speech -u root --exec python3 /mnt/g/InnoTechx/Dev/ai-digital-human-live/test/speech-service.test.py
```

协议测试使用替身，不代表真实模型可用。真实验证须分别检查参考录音识别、克隆 PCM/试听、health 加速状态、取消、停止后的 GPU 进程和应用重启。付费 Vidu 在线口型测试应单独记录。

来源：[OmniVoice](https://github.com/k2-fsa/OmniVoice)、[FunASR](https://github.com/modelscope/FunASR)、[NVIDIA WSL CUDA](https://docs.nvidia.com/cuda/wsl-user-guide/)。
