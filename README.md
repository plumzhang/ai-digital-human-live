# 数字人直播中控台

Windows 桌面客户端，使用 Tauri 2 + React、Vidu S2-Avatar **组件版**、本地 FunASR 中文 ASR、WSL2 OmniVoice 声音克隆（FlashInfer + CUDA Graph）和 dyhub。

当前链路：麦克风 → VAD 分句 → FunASR /api/stt → 自己的 LLM 流式回答 → 按句合成克隆语音 → 24kHz / 单声道 / s16le PCM → Vidu WebSocket → 托管阿里 RTC → OBS 播放窗口。弹幕、礼物和手动提问直接进入 LLM。Vidu 不负责识别、回答或合成声音。

## 安装与开发

需要 Windows、Node.js 20+、Rust MSVC、Visual Studio C++ Build Tools、WebView2；语音服务需要 WSL2 和 NVIDIA CUDA GPU。

```powershell
npm install
npm run setup:speech
npm run dev:desktop
```

安装器创建独立的 Ubuntu 24.04 WSL2 发行版 InnoTechx-Speech，保留 Docker 环境。FunASR 在 CPU 环境运行，OmniVoice 在独立 CUDA 12.8 环境运行。需要可用的 WSL2 和 NVIDIA GPU；启动时执行实际推理，验证 FlashInfer + CUDA Graph 后才报告就绪。环境与模型不修改系统 Python。首次安装需下载数 GB 模型和依赖。

统一基础地址为 http://127.0.0.1:8766：

| 接口 | 功能 |
| --- | --- |
| POST /api/stt | FunASR Paraformer 中文识别，返回文字和毫秒时间戳 |
| POST /api/tts | OmniVoice 参考录音声音克隆，返回24kHz单声道s16le PCM |
| POST /api/tts/cancel | 按回答 request_id 取消当前与排队句子 |
| GET /health | 模型、设备和实际加速验证状态 |

## 配置与使用

1. “模型配置 → 大语言模型”：保存 OpenAI 兼容地址、Key、模型和回复规则。模型必须支持 Chat Completions SSE。旧版默认提问优化规则会迁移为主播回答规则；自定义规则保留，请检查其中是否仍要求“只优化提问”。
2. “模型配置 → OmniVoice 语音”或“音色克隆”：保存参考录音的 Windows 绝对路径和对应原话，点击“启动本机服务”，待 FunASR、FlashInfer、CUDA Graph 显示已就绪/已验证后生成克隆试听。软件自动将 C:/G: 等本机路径映射到 WSL2。原 Qwen 配置中的参考路径和原话会保留，新服务固定使用 k2-fsa/OmniVoice。关闭本机服务可在加载、试听或播报期间停止 Linux 进程组并释放显存，同时暂停自动回答和麦克风；未完成播报保留人工确认。
3. “模型配置 → Vidu数字人”：填写 Vidu API Key；“形象设定”保存形象和当前主播人设。旧版音色及高级设置留在存储中，组件版不再使用这些参数。
4. “直播中控”启动数字人。创建前检查 TTS 服务和所选模型；使用 managed_rtc artc 继续订阅音视频，无需自建 RTC。
5. 开启自动回答后处理弹幕和礼物；手动提问在当前播报结束后优先执行。“开启麦克风识别”只采集本地音频，FunASR 通过本机 /api/stt 识别，不向 RTC 发布麦克风。用户开口即打断旧回答，句尾静音约900毫秒后识别并回答。
6. OBS 添加“窗口采集”，选择“数字人画面 · OBS 窗口”。字幕显示实际送入 TTS 的台词。播报结束须满足全部 PCM 已发送、下行实际发声后持续静音、音视频健康；断流或失败保留人工确认，不自动重复播放。

手动提问和麦克风回答逐句流水执行：每句内部先完成合成，播放当前句时准备下一句。弹幕与礼物槽位提前生成回答，TTS 空闲时按句预合成整条回答的 PCM，轮到该槽位才发送缓存音频。单句内部并非原生 token 级音频流式。

也可运行 npm run start:speech。应用管理的服务随应用退出释放；终端启动的服务可在软件中显式关闭。启停只作用于经过 PID、启动时间和命令行核实的语音进程组，不终止整个 WSL 发行版。Windows 配置和日志位于 %LOCALAPPDATA%/com.innotechx.digitalhuman.live/speech；WSL 环境和模型位于 /opt/innotechx-speech。setup:tts / start:tts 为新语音服务的兼容命令。

## 互动队列与唱歌

保留六槽位队列、礼物优先、持久化、过滤、手动测试、承接动作及多数字人卡片。弹幕由模型判断动作意图，普通问题默认看向镜头，明确动作请求生成对应描述。组件版槽位和承接动作依次发送 type=97 动作提示词与 type=9 动作驱动文本，确认两条均写入连接后显示“已发送”。完成后的承接动作按原配置等待，不再依赖下行 ASR 匹配比例。

后台最多并行准备两条回答，OmniVoice 只运行一个合成任务；当前槽位发送 PCM 时，后续槽位仍继续准备。槽位提前显示回答及“正在预合成声音 / 声音就绪”状态，播放时复用 PCM，不再调用模型或 TTS。跳过、重新生成、切换会话和修改音色会清理对应缓存；PCM 只保存在本机内存，重启后重新合成。

新建歌曲的原始歌词时间轴由 FunASR 转录，再由 LLM 参照歌词校正。唱歌继续使用已保存的原歌曲和歌词时间轴。播放时将原歌曲实际波形转换为24kHz PCM送入组件版，歌词只发送转写文字，不经TTS；OBS播放原歌曲并静音RTC下行，防止双重声音。发送积压超过500毫秒、断流或播放停滞会停止并保留任务。口型相对于本地原歌曲的实际渲染延迟仍需现场调试，歌词提前量不等于PCM或视频延迟补偿。

## 检查与打包

```powershell
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run package:win
```

安装包位于 src-tauri/target/release/bundle/nsis。首次使用仍需安装 WSL2 语音运行环境与模型；模型不打入安装包。

详细协议、队列边界和迁移见 [组件版实现说明](docs/component-flow.md)。[实时版历史文档](docs/realtime-legacy.md) 只供排查旧版本，不适用于当前接入。

接口与部署细节见 [语音服务](docs/speech-service.md)，本机识别、克隆、加速与关闭验证见 [验证记录](docs/speech-validation.md)。[旧版 Qwen 验证记录](docs/component-validation.md) 保留历史结果。
