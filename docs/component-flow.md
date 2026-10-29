# S2-Avatar 组件版实现

协议来源：[Vidu 组件版详细参数](https://platform.vidu.cn/vidu-stream/doc/s2-avatar/component/parameters)、[OmniVoice 官方仓库](https://github.com/k2-fsa/OmniVoice)、[FunASR 官方仓库](https://github.com/modelscope/FunASR)。

## 会话与媒体

Rust 使用 `POST /live/s_avatar/component`，请求包含 model、image_uri、`managed_rtc: {provider: "artc"}` 和动作库配置。返回的 managed_rtc 适配现有 AliRTC 播放窗口；凭证不会进入模型请求或诊断日志。

控制与音频共享 `/live/v1/external-lives/{live_id}/stream?conn_id=...` WebSocket，服务端 Header 使用 `Authorization: Token ...`。首帧发送 type=1 conn_init，收到成功的 type=2 后才允许音频。NOT_READY 在同一连接中重试，并响应 ping/pong；初始化最长60秒。

主窗口注册实时事件后立即读取本机 session_snapshot，并每2秒同步当前会话的 ready 状态，以恢复初始化回执漏接或前端刷新后的界面状态；不会通过该同步创建新会话。结束、断开或换会话会使旧的异步读取失效。OBS 响应 rtc-status-request 返回现有入会及订阅状态，不重新入会。槽位分别提示等待创建、控制初始化、OBS入会、麦克风状态或开启自动回答；采集与启动数字人不会自行开启自动回答。

创建后立即保存 live ID，再尝试控制连接；握手失败仍能查询和挂断该会话。结束操作先取消本地生成，再发送 type=5；必须查询到 ended 才清除会话，不用本地断开推断计费已结束。

## 手动提问与麦克风的三段流水线

`component.rs` 将每次回答分成三个并行 future，用有界通道相连：

1. 读取 LLM 的 OpenAI SSE，按中文句号、问号、感叹号、分号、换行切句；无标点时最多100字符。通道最多保留两句。保留 UTF-8 字节直到完整 SSE 行，不把 reasoning_content 送去朗读。异常断流或非 stop 结束会取消本次回答。
2. 逐句请求本机 OmniVoice，缓存的 voice_clone_prompt 保持音色。当前实现使用官方 OmniVoice 的完整句子推理，音频通道最多保留一句；当前句发送期间可合成下一句。这里的流式是句子级流水线，不宣称官方 Python 函数逐块返回音频。
3. 校验 HTTP 返回的 X-Audio-Sample-Rate=24000、X-Audio-Channels=1、X-Audio-Format=s16le，拒绝 WAV/MP3 容器和半个采样。将 PCM 按20ms/960字节切分，每块等待 WS 写入确认，并按音频时长节流。每帧写入成功后通过 component-pcm 定向交给 OBS 窗口的 Web Audio 播放器，以24kHz单声道解码并连续排程，初始缓冲约30毫秒；预合成阶段不播放。组件版声音由本机负责，RTC仅承担数字人画面，远端音频始终静音以避免重音。

本地播放器按 live ID 和语音 epoch 隔离，打断、切歌和结束会话会停止已排程帧，旧写入回执不会恢复被取消的声音。断开会话即释放播放器；自动播放受限时显示恢复按钮，播放失败会打断当前生成，禁止静默积压后补播。本地播放进度不代表 Vidu 视频渲染完成，音画实际延迟仍需现场验证。

“互动任务队列 → 槽位播放设置”按承接动作、弹幕PCM发送延迟、本地弹幕PCM播放延迟排列。发送和播放延迟均为0–10000毫秒，默认0，本机保存并在下一槽位冻结为 task.pcm_timing。所有延迟以 task.started_at（槽位进入playing时）为共同起点，回复动作也改为从该时刻计时。前端配置调用与持久化耗时计入已过去的时间，不重新开始延迟；各项时间不相加。

组件槽位开始后，原生将当前缓存的各句PCM以base64定向交给OBS，携带同一epoch及绝对play_at_ms；OBS按该时刻安排Web Audio播放，并保留约30毫秒设备缓冲。上行发送独立等待started_at+send_delay_ms，随后继续20毫秒分帧、写入确认与实时节流。本地播放可以早于或晚于上行发送，完整缓存只交给当前播放窗口，不进入队列持久化文件。手动提问和麦克风回复继续使用逐帧写入后本地播放的流水线。等待中的音频仍受epoch打断控制，缓存总时长最多60秒；播报超时预算增加配置的最大发送/播放等待时间。

TTS 服务把浮点波形裁剪、量化为有符号16位小端；必要时重采样到24kHz。每句的文字通过 type=10 output_transcription 上送 Vidu，同时本地发送带 request_id 的累计台词事件供字幕和持久化使用。最终事件只表示全部 PCM 已发送，不表示观众已经听完。

LLM 的口播协议优先于人设中遗留的 JSON 输出规则。普通纯文本回答仍按句立即进入 TTS；若模型返回 JSON 或 JSON 代码块，先等待完整对象，仅提取 speech（兼容 answer、text、segments[].text），不朗读 emotion、动作字段、花括号或思考过程。无有效台词或截断 JSON 会明确失败，不把结构片段当成回答。TTS 接口另行拒绝结构化字段和纯标点，异常波形区分空音频、超长和非有限采样并返回502，不用静音替代失败。

弹幕先由模型判断动作意图，不再以关键字筛选决定是否规划，因此“札一下马尾”“笑一下”等请求也进入判断；普通问题仍默认看向镜头。礼物沿用固定的比心、亲吻手势或飞吻。

## 槽位提前准备回答与 PCM

后台最多同时准备两条回答。`component_prepare_reply` 在当前组件会话的主播人设下生成实际口播文字，不占用播报通道。回答完成即显示在槽位中；同观众历史仍只采用已完成的互动，预生成回答不冒充已经说过的内容。

实际口播的system提示显式要求遵守 opening_style、避免 recent_answer_openings 的重复起手词与句式。队列在串行提交结果时使用最新上下文再次核验，避免两条并发请求都还看不到对方的开头。`replyDiversity.ts`比较开场语气词、前四字句式和短开场，统一标点、昵称与“哎呀／哎哟／哎呦”等变体；正文中出现相同词语不算重复开头。上下文采用最近六条已播回答与其余已生成槽位，最多八个开头片段，只作风格提示，不混入其他观众的互动历史。

重复草稿不进入ready或TTS，调用 `rewriteComponentReply` 只重写口播，不重跑动作规划。初次输出后最多追加两次重写；仍重复则保留可见失败。旧版已就绪的重复回答先移除PCM句柄再重写，即使两条模型并发额度已占满，也先阻止重复缓存进入播放。跳过、重试、换会话后，旧改写结果仍受generation_token校验，不能覆盖新任务。

`component_prepare_audio` 使用 TTS 全局互斥锁的 try_lock：TTS 忙则保留回答并稍后重试，空闲则按句合成整条回答的24kHz单声道s16le PCM。预合成只访问本机语音服务，不发送 Vidu 指令或音频。后台任务一次一个；当前槽位发送缓存 PCM 时不占用 TTS，其他槽位可继续预合成。手动提问、麦克风和试听优先，可以取消正在预合成的任务。

PCM 由 `prepared_speech.rs` 保存在 Rust 进程内存中，最多三个缓存、合计24MB、单条不超过60秒；待播槽位和持久化文件只保存句子、状态、时长与句柄。轮到当前槽位时才发送动作，并由 `component_play_prepared` 一次性取出缓存，上行复用逐帧节流、写入确认、字幕和最终发送事件，本地播放独立获得当前缓存，不再请求 LLM 或 TTS。回答生成和音频准备的调度独立于正在等待完成的音频发送任务。

缓存绑定会话、槽位、回答原文、TTS配置和参考录音的修改时间。跳过、重新生成、会话切换、关闭语音服务或修改音色后删除对应缓存并取消过期推理；迟到结果不能写回新任务。刷新前端后不复用旧句柄，新窗口的缓存所有权也防止旧窗口迟到的清理删除新缓存。生成失败保留可见错误，缓存不会当作已播出证据。

槽位和承接动作由 component_action 在同一会话锁内依次排入两条信令：type=97 / payload.session_update.action_description 设置底层动作提示词；type=9 / payload.text_msg 提交动作驱动文本，并携带对应槽位或承接任务 msg_id。只有两条均写入 WebSocket 后才显示“已发送”。未就绪、连接断开、写入超时或打断会返回错误；Vidu 没有为这两种信令提供动作完成回执，实际执行以画面为准。动作发送失败仍保留错误并继续口播，不自动重复动作。手动和麦克风输入继续通过 type=9 上送原始文字，并维护本次会话最近六轮历史；弹幕历史只使用同观众的已完成互动，不混用其他观众经历。

组件版的承接动作归属即将开始的槽位，保存在 task.handoff_action；承接动作延迟保存在 task.handoff_action_delay_ms，回复动作延迟保存在 task.reply_action_delay_ms，二者范围均为0–60000毫秒、独立保存。界面承接动作区域只设置承接延迟，回复动作在独立区域设置回复延迟。`component_play_prepared` 接收槽位started_at及冻结的各项延迟；原生将同一个槽位时间转换为单调时钟起点。承接动作在started_at+handoff_delay_ms触发，回复动作在started_at+reply_delay_ms触发，上行在started_at+send_delay_ms开始，本地在started_at+play_delay_ms开始；它们独立调度，动作写入等待不重新开始其他计时。

动作计时future、上行发送与本地播放共同受会话generation取消；临界发送前再次核对会话、epoch与speaking。上行和本地音频均结束后仍未到达回复动作触发时间则取消该动作，不拖延槽位也不向后续槽位发送。component-slot-action事件携带会话、槽位、playback_token和动作种类，只有当前播放实例能更新状态。旧版全局handoff_action及wait_ms只用于历史非组件队列。待播槽位同步新配置，已开始槽位使用冻结的方向、角度、回复动作延迟及PCM发送/播放延迟。

对于 api.deepseek.com 的实时回答和动作规划请求，显式关闭 thinking（deepseek-reasoner 除外），防止默认思考消耗短输出预算后返回空内容；结构化规划采用1024 token预算，达到长度上限时明确失败。其他服务商不注入 DeepSeek 专用参数。

## 打断与错误

每次回答占用一个会话级 generation。打断、会话结束、WS断开都会使旧 generation 失效。LLM、TTS、发送 future 一起取消；排队但尚未写出的旧 PCM 帧也检查 generation。只有仍属于当前 generation 的完成回调能释放发送占用或追加对话历史。

本地 TTS 支持 `/api/tts/cancel`，在每个扩散推理步骤的 _predict_tokens_with_scoring 检查取消标志（包括 CUDA Graph 路径），尽快中止旧推理；线程服务器可在推理期间接收取消和健康检查，模型推理始终串行。开始生成后出现 LLM/TTS 错误时，向 Vidu type=7 清理可能已开始渲染的局部回复。错误不自动重试已发出的声音。

队列持久化 audio_sent_at 和实际台词 final，默认启用 FunASR 本地播报确认。OBS 从 Web Audio 播放分支的 MediaStream 音轨采集实际排程输出，经现有 AudioWorklet 检测 VAD 并重采样到16kHz PCM，调用本机 /api/stt；不给 ASR 输入预期回答，识别结果独立于生成文字。不要求存在 RTC 音频发布者，空闲时本地输出静音维持队列就绪观测。组件回答只与完整的 prepared_reply 匹配；旧任务没有完整预生成文字时，须等待最终台词，防止用第一句作为完整回答提前结束。

全部 PCM 写入完成且台词 final 后，要求已观察到本地播放发声，当前会话/槽位/采集ID一致，ASR采集时刻不早于 audio_sent_at 和最近一次发声；音频回调需在500毫秒内、画面回调需在2秒内。15字以上（含15字）比较末尾10字，更短回答比较全文，匹配度默认70%（可配50–100%），并单独要求最后3字完全一致；不足3字则核验整句。标点与数字读法归一，同音字按拼音音节核验。达到条件立即确认槽位完成并允许下一就绪槽位开始，不再额外等待1500毫秒、1200毫秒静音或原承接间隔。后续媒体断流或不健康时仍阻止开始。

发送完成时间通过 whisper-task 同步给 OBS。若此前已提交过静音结尾批次，会保留音频和识别时间轴，再提交一次发送完成后的结尾批次，避免旧识别结果被正确拒绝后不再产生新结果。FunASR错误或断流转为人工确认；60秒未确认同样保留任务。禁用识别的兼容队列仍使用原“全部PCM发送完至少1500毫秒＋下行静音1200毫秒”逻辑。所有判断都是本地实际播放观测，并非供应商精确播放结束回执。

## 麦克风

OBS 窗口通过 getUserMedia 采集，不向 RTC 发布。AudioWorklet 获取波形，本地 VAD 检测开口，首先取消旧回答；保留约300毫秒前滚，句尾静音约900毫秒后把16kHz PCM交给常驻 FunASR /api/stt。

每段最多20秒；关闭麦克风、新一段开口或会话切换后，旧识别结果不能触发回答。音频分析分支保持静音。麦克风输入与本地PCM播报确认都使用 FunASR；本地播报只在当前槽位播放期间识别，歌曲本身与麦克风互动不参与槽位结尾匹配；歌曲间奏中的弹幕回复仍使用同一FunASR结束确认。

## 本机运行环境

setup:speech 创建独立 InnoTechx-Speech WSL2 发行版，Linux 运行环境位于 /opt/innotechx-speech，Windows 配置与日志位于 %LOCALAPPDATA%/com.innotechx.digitalhuman.live/speech。FunASR 使用 CPU 和独立 transformers 4 环境；OmniVoice 使用 GPU、transformers 5、CUDA 12.8、FlashInfer。PyPI 的 OmniVoice 0.2.1 不包含加速模块，安装器固定官方源码 revision，详见 [语音服务](speech-service.md)。

应用的 component_start_local 启动 Linux 服务，通过 /health 等待真实 GPU 预热、FlashInfer、CUDA Graph 和 FunASR 全部就绪。component_stop_local 通过 Linux 控制器验证 PID、启动时间和命令行后停止进程组，加载期间也可关闭；不调用 wsl --terminate，不影响 Docker。generation 防止迟到的启动或试听回调覆盖关闭状态。终端启动的同一服务也可在软件内显式关闭。应用退出只释放自己管理的实例。

关闭服务会取消普通语音、暂停自动回答和麦克风，并保留当前任务人工确认。原歌曲 PCM 不依赖 TTS。迁移时只允许停止已核实解释器和脚本路径的旧 Windows Qwen 服务。新服务固定模型 k2-fsa/OmniVoice，UI 回显真实设备、FunASR 和已验证的加速状态；模型加载或加速失败不会冒充已就绪。

`voice.json` 可提供本机预设参考，首次启动且尚无已保存参考时导入。后续以界面保存的配置为准；自定义参考文件不会被安装脚本覆盖。组件、模型、TTS Key 分别使用自己的配置，不把 Vidu Key 发到 LLM/TTS。

## 歌曲

歌曲导播在生成、校正或保存歌词时间轴后调用 song_pcm 预截取。使用已安装WSL2环境的FFmpeg一次性解码原文件为24kHz单声道s16le，按 start_ms×48 到 end_ms×48 字节范围截取每段，存放在歌曲目录 pcm/<revision>/segment-NNNN.pcm。pcm.json 记录格式、源文件大小与修改时间、完整时间轴和版本。重复歌词仍分别按各自时间截取。新文件全部生成后原子发布清单，失败保留原有效缓存，旧版本仅在发布后清理；源文件或时间轴变化时缓存失效。原歌曲与 raw.srt 保留。

旧歌曲通过 director_prepare_pcm 准备，新生成和保存时间轴自动准备。director_get/list 回显 pcm_ready、各段路径/样本数与 pcm_lead_ms；未就绪禁止加入队列和播放。已入队歌曲不能修改/删除或重新截取，防止替换正在使用的片段。预截取不需要启动GPU模型；WSL2语音环境提供FFmpeg，播放已有片段不依赖TTS服务。

SongAudioBridge在开始播放前以最多四个并行文件读取加载PCM片段，按原歌曲时钟每20毫秒发送480采样。只发送与歌词区间相交的帧，边界不足20毫秒的部分补零，完整间奏不发送静音帧；跨段边界精确到1毫秒，重叠歌词引用同一原始采样，不叠加人声。后端核对播放token与递增序号，积压超过500毫秒或时钟大幅跳变停止播放，避免补发一串过期歌词音频。歌词导播仍只发送type=10转写文字并更新字幕，不调用TTS。

PCM提前量和歌词文字提前量在歌曲编辑区分别设置0–5000毫秒，点击“保存提前量”单独保存，已入队也可修改。director_save_timing只改提前量和文字派发时刻，不改歌词、切片边界或PCM文件；PCM缓存校验排除文字提前量差异，保留原音频、文字和边界校验。待播歌曲读取新设置，已加载的当前播放这一轮不变，下次生效。完整时间轴编辑和重新截取PCM仍保留队列保护。PCM提前量默认0，与歌词文字的lead_ms独立。无论提前量是否为0，OBS都由HTMLAudioElement正常播放完整原曲，不创建延迟音频节点、不改变声音输出和播放进度。PCM片段按原始开始时刻减去PCM提前量提前调度。songPcmSchedule先合并相交的原始区间，提前后最早从0开始；开头区间因截零发生冲突时按源顺序完整发送，避免覆盖丢词，后续空档足够时恢复配置提前量。PCM发送器仍按20毫秒帧发送，不在结束时等待人为延迟的尾音。timeline.json保留send_at_ms作为文字发送时刻，并提供text_send_at_ms和pcm_send_at_ms；Rust导出与前端预览/发送使用相同的调度规则。

OBS歌曲使用new Audio()创建，先设置crossOrigin=anonymous、muted=false、volume=1，再设置asset资源src。Tauri asset协议返回匹配窗口来源的Access-Control-Allow-Origin；此属性用于跨域资源播放，PCM提前量不依赖Web Audio或MediaElementAudioSourceNode。RTC静音仅作用于AliRTC的远端音频，完整原曲由OBS窗口本地播放。

本地完整原歌曲保留为可听声音，RTC下行静音以防重音；Vidu只在唱词区间接收对应原唱音频；歌词空档释放通道给弹幕回复。文字提前量只控制转写调度，PCM提前量只改变PCM的发送时刻，本地原曲保持正常播放。实际视频渲染延迟需要目标环境试听测量，不应宣称已保证逐帧同步。

## 迁移与验证

保留旧形象卡片、声音关联和历史数据，不调用旧付费克隆接口。原 Qwen 参考录音和原话自动保留，服务地址迁移为基础地址、模型改为 OmniVoice。旧版默认模型人设迁移为直接回答；自定义人设保留。曾经正在播放的任务恢复为人工确认，不重播。

自动验证覆盖 SSE 首句在完整回答结束前发出、截断流拒绝、PCM格式拒绝、句间静音不完成任务、断流不确认完成、麦克风开口先打断、迟到识别丢弃、权限拒绝及本地采集释放。真实模型克隆和付费 Vidu 端到端验证须分别记录，构建通过不代表已完成在线口型测试。

## 歌曲与弹幕的音频优先级

歌曲留在槽位1，槽位2、3作为子队列。需要打开自动回答弹幕；关闭时不生成、不执行动作、不自动释放子槽位，原曲继续播放。唱词期间，意图规划只调用 generate_interaction，不生成口播回复，也不预合成TTS。明确动作请求及礼物手势独立提交动作信令，无动作的弹幕立即归档跳过。默认看向镜头不视作明确动作。槽位2消费后，槽位3前移，末尾从最新候选补位。

歌曲间奏允许子槽位按原有流程生成回答、准备PCM、播放并通过FunASR完成。歌曲父任务和一个弹幕子任务可以同时处于playing，但持久化校验必须验证父子任务ID和播放token对应；不允许两条无关语音同时播放。歌曲只由原曲ended完成，子槽位的语音/动作不能消费掉父任务。原曲在间奏回复中结束时，仅移除父任务，已开始的弹幕可以继续。

song_audio.rs 在同一个Session锁内管理 component_song_open、component_song_phase、component_song_close 和 component_interrupt_reply。桥接器在首个唱词帧前先确认原生阶段切换，取消旧语音epoch并排入type=7打断，随后才写入歌曲二进制PCM；当前处于唱词阶段时，原生run_audio也会拒绝弹幕PCM。阶段结束只释放歌曲自己的音频所有权；旧token、旧子槽位取消和旧歌曲清理不能停止新歌曲或间奏回答。每段重新声明当前连续帧序号，完整间奏不发送PCM。

OBS始终播放完整原曲，RTC音频始终静音。歌词空档使用本地PCM播放器播报弹幕，静音/健康观测及FunASR均来自本地播放分支；唱词开始会打断间奏回复并停止已排程的本地语音，同时关闭子槽位的FunASR捕获；下一次间奏回复使用新采集ID。原生阶段通过song-pcm-phase通知界面，本机会话快照也携带song_phase补回漏接状态；快照的旧阶段不能覆盖较新的实时事件。

回归验证覆盖：空档不发送静音帧、首帧等待原生抢占、500毫秒积压保护、动作模式跳过回复生成和TTS、槽位2/3轮转、自动回答关闭、FunASR确认间奏完成、唱词打断未发送完的弹幕、父歌曲结束时保留已开始的子回复、旧token隔离及父子状态持久化。测试不创建收费Vidu会话，实际画面口型和网络切换延迟仍需现场验证。
