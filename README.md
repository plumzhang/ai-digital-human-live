# 数字人直播中控台

Windows 桌面客户端，使用 Tauri 2 + Rust、Vidu S2-Avatar 实时版和 dyhub。中控台控制会话、弹幕抽取、规则过滤、人工提问和打断；独立窗口可供 OBS 使用“窗口采集”。

## 开发

需要 Windows、Node.js 20+、Rust MSVC 工具链、Visual Studio C++ Build Tools、WebView2 和 Chrome。

```powershell
npm install
npm run dev:desktop
```

打包：

```powershell
npm run package:win
```

安装包在 `src-tauri/target/release/bundle/nsis/`。`package:win` 会构建 dyhub、复制其依赖与 Node 运行时，并生成安装包。

日常调试运行 `npm run dev:desktop`，不需要安装。首次运行时若 dyhub 尚未构建，脚本会自动准备；之后前端保存即热更新，Rust 修改后由 Tauri 重新编译。

## 使用

1. 在“形象与配置”填写 Vidu API Key、形象图片、音色和人设，点击“保存配置”。成功后重启客户端会恢复配置，包括所选的本地形象图片。Key 也会保存在本机应用存储中，可以在页面中清除。本软件不会收集 Key 或将它发送到自有服务器；调用 Vidu 接口时会直接发送给 Vidu。
2. 在“直播中控”创建数字人，即可在没有抖音直播间时手动提问调试。创建后自动打开独立播放窗口。播放窗口加入实时会话后，可以点击“开启麦克风推流”，在 Windows 权限提示中允许麦克风，然后直接用中文语音与数字人对话；点击“关闭麦克风”停止推流。
3. 输入抖音直播间的 `web_rid`，点击“启动获取弹幕”，再开启自动回答。每 10 秒从最近 20 条合格弹幕中随机选择一条。回答期间到达的弹幕丢弃。
4. OBS 添加“窗口采集”，选择“数字人画面 · OBS 窗口”。背景为纯色。
5. 在“弹幕过滤”配置关键词和正则。命中规则的弹幕仍显示在中控台，并附带屏蔽原因。

麦克风开启期间，自动弹幕提问暂停，新弹幕标记为已丢弃；关闭麦克风后恢复自动抽取。麦克风音频直接通过 AliRTC 发送给 Vidu，不会填入文字提问框。

## 已知接口限制

- Vidu 音色克隆文档同时声明 `audio_url` 支持 data URI 且最大长度为 2048 字符。客户端允许选择本地音频并尝试提交；如果 Vidu 拒绝，使用公网音频 URL。
- Vidu 的文字消息和打断信令没有单独业务确认。中控台通过 RTC 音量与输出转写估计回答结束；超过 45 秒会释放忙碌状态。应在有真实 API Key 的环境中验证具体时序。
- 麦克风推流依赖 Windows 麦克风权限、WebView2 和真实的 Vidu RTC 会话；目前没有可用的 Vidu API Key，端到端语音交互仍需实测。
- 本机需安装 Chrome 供 dyhub 默认浏览器采集内核使用。客户端仅停止它自己启动的 dyhub；如果端口 8757 已有外部 dyhub，客户端会直接连接。

dyhub 来源：[ymstar/dyhub](https://github.com/ymstar/dyhub)，MIT 许可，当前版本提交 `3f1276e21cb6e68d5b28edc152dbc4b6e96d2b43`。
