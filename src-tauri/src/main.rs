#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod model_api;
mod queue_store;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, process::{Child, Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::{SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::{mpsc::{unbounded_channel, UnboundedSender}, oneshot};
use tokio_tungstenite::{connect_async, tungstenite::{client::IntoClientRequest, http::HeaderValue, Message}};

#[cfg(windows)]
mod single_instance {
    use std::{ffi::c_void, iter, ptr};

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateMutexW(attributes: *mut c_void, initial_owner: i32, name: *const u16) -> *mut c_void;
        fn GetLastError() -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(window: *mut c_void, text: *const u16, caption: *const u16, style: u32) -> i32;
    }

    pub struct Guard(*mut c_void);

    impl Guard {
        pub fn acquire() -> Option<Self> {
            let name: Vec<u16> = "Local\\InnoTechx.AiDigitalHumanLive".encode_utf16().chain(iter::once(0)).collect();
            let handle = unsafe { CreateMutexW(ptr::null_mut(), 0, name.as_ptr()) };
            if handle.is_null() { return None; }
            if unsafe { GetLastError() } == 183 {
                unsafe { CloseHandle(handle); }
                let message: Vec<u16> = "数字人直播中控台已运行，已阻止重复启动，避免并行创建数字人。".encode_utf16().chain(iter::once(0)).collect();
                let title: Vec<u16> = "数字人直播中控台".encode_utf16().chain(iter::once(0)).collect();
                unsafe { MessageBoxW(ptr::null_mut(), message.as_ptr(), title.as_ptr(), 0); }
                return None;
            }
            Some(Self(handle))
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) { unsafe { CloseHandle(self.0); } }
    }
}

#[derive(Default)]
struct AppState {
    dyhub: Mutex<Option<Child>>,
    session: Mutex<Option<Session>>,
    creating_session: AtomicBool,
}

struct CreateSessionGuard<'a>(&'a AtomicBool);

impl<'a> CreateSessionGuard<'a> {
    fn acquire(flag: &'a AtomicBool) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "数字人正在创建中，请等待当前请求完成，避免重复计费".to_string())?;
        Ok(Self(flag))
    }
}

impl Drop for CreateSessionGuard<'_> {
    fn drop(&mut self) { self.0.store(false, Ordering::Release); }
}

struct Session {
    live_id: String,
    conn_id: String,
    key: String,
    region: String,
    rtc: Value,
    sender: UnboundedSender<Outbound>,
    seq: u64,
    last_video_frame_ms: u128,
    voice_provider: String,
}

struct Outbound {
    message: Message,
    written: Option<oneshot::Sender<Result<(), String>>>,
}

#[derive(Serialize, Clone)]
struct SessionSnapshot { live_id: String, rtc: Value, voice_provider: String }

#[derive(Deserialize)]
struct AvatarSettings {
    image_uri: String,
    persona: String,
    voice: String,
    voice_provider: String,
    greeting_instruction: String,
    advanced: AdvancedSettings,
}

#[derive(Deserialize)]
struct AdvancedSettings {
    persona_enhance: bool,
    idle_action: bool,
    enable_transcription: bool,
    vad_type: String,
    vad_threshold: f64,
    silence_duration_ms: u32,
    vad_idle_timeout_ms: u32,
    temperature: f64,
    top_p: f64,
    top_k: u32,
    max_tokens: u32,
    idle_timeout_seconds: u32,
}

fn api_host(region: &str) -> &'static str {
    if region == "global" { "https://api.vidu.com" } else { "https://api.vidu.cn" }
}

fn ws_host(region: &str) -> &'static str {
    if region == "global" { "wss://api.vidu.com" } else { "wss://api.vidu.cn" }
}

fn normalized_key(key: &str) -> Result<String, String> {
    let key = key.trim().trim_start_matches("Token ").trim();
    if !key.starts_with("vda_") { return Err("Vidu API Key 应以 vda_ 开头".into()); }
    Ok(key.to_string())
}

async fn response_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Vidu HTTP {}: {}", status, body));
    }
    Ok(body)
}

fn unix_ms() -> u128 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() }

fn session_signal(text: &str, live_id: &str) -> Option<Value> {
    let mut signal: Value = serde_json::from_str(text).ok()?;
    // Transcription frames omit live_id. Bind all events to the trusted
    // WebSocket session before sending them to the console and OBS windows.
    signal.as_object_mut()?.insert("live_id".into(), json!(live_id));
    Some(signal)
}

fn playback_expired(started_seconds: u64, ready_seconds: Option<u64>, frame_age_ms: u128) -> bool {
    match ready_seconds {
        Some(seconds) => seconds >= 30 && frame_age_ms >= 30_000,
        None => started_seconds >= 90,
    }
}

#[tauri::command]
async fn create_session(app: tauri::AppHandle, state: State<'_, AppState>, key: String, region: String, avatar: AvatarSettings) -> Result<SessionSnapshot, String> {
    let _creation_guard = CreateSessionGuard::acquire(&state.creating_session)?;
    if state.session.lock().map_err(|e| e.to_string())?.is_some() { return Err("已有运行中的 Vidu 会话，请先结束".into()); }
    let key = normalized_key(&key)?;
    if avatar.image_uri.trim().is_empty() || avatar.persona.trim().is_empty() { return Err("请填写形象图片和人设".into()); }
    if avatar.greeting_instruction.chars().count() > 200 { return Err("开场白指令不能超过 200 字".into()); }
    if avatar.voice_provider != "qwen_omni" && avatar.voice_provider != "doubao" { return Err("音色供应商无效，请在形象与配置中重新选择".into()); }
    let advanced = &avatar.advanced;
    if advanced.vad_type != "server" && advanced.vad_type != "semantic" { return Err("语音打断模式无效".into()); }
    if !(0.0..=1.0).contains(&advanced.vad_threshold) || !(200..=6000).contains(&advanced.silence_duration_ms)
        || (advanced.vad_idle_timeout_ms != 0 && !(500..=30000).contains(&advanced.vad_idle_timeout_ms))
        || !(0.0..2.0).contains(&advanced.temperature) || !(0.0..=1.0).contains(&advanced.top_p) || advanced.top_p == 0.0
        || advanced.top_k > 100 || !(1..=65536).contains(&advanced.max_tokens)
        || !(10..=7200).contains(&advanced.idle_timeout_seconds) {
        return Err("高级配置超出 Vidu 允许的范围，请检查输入值".into());
    }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(90))
        .build().map_err(|e| e.to_string())?;
    let voice_model = if avatar.voice_provider == "doubao" {
        json!({"provider":"doubao","doubao":{"voice":avatar.voice}})
    } else {
        json!({"provider":"qwen_omni","qwen":{"voice":avatar.voice}})
    };
    let body = json!({
        "model": "vidu-s2",
        "call_mode": "video",
        "rtc": {"provider": "artc"},
        "character_id": "1",
        "voice_model": voice_model,
        "avatar": {
            "image_uri": avatar.image_uri,
            "persona": avatar.persona,
            "voice": avatar.voice,
            "greeting_instruction": avatar.greeting_instruction,
            "persona_enhance": advanced.persona_enhance,
            "idle_action": advanced.idle_action
        },
        "audio": {"enable_transcription": advanced.enable_transcription},
        "action": {"enabled":true,"library_id":"0"},
        "vad": {"type":advanced.vad_type,"threshold":advanced.vad_threshold,"silence_duration_ms":advanced.silence_duration_ms,"idle_timeout_ms":advanced.vad_idle_timeout_ms},
        "llm": {"temperature":advanced.temperature,"top_p":advanced.top_p,"top_k":advanced.top_k,"max_tokens":advanced.max_tokens},
        "idle_timeout_seconds": advanced.idle_timeout_seconds
    });
    let response = client.post(format!("{}/live/s_avatar/realtime", api_host(&region)))
        .header("Authorization", format!("Token {}", key)).json(&body).send().await.map_err(|e| e.to_string())?;
    let data = response_json(response).await?;
    let live_id = data.pointer("/live/id").and_then(Value::as_str).ok_or("Vidu 响应缺少 live.id")?.to_string();
    let rtc = data.get("rtc").cloned().ok_or("Vidu 响应缺少 RTC 凭证")?;
    let _ = app.emit("live-created", json!({"live_id": live_id, "status": data.pointer("/live/status")}));
    let conn_id = format!("desktop-{}", uuid::Uuid::new_v4());
    let url = format!("{}/live/ws/live/connect?live_id={}&conn_id={}", ws_host(&region), live_id, conn_id);
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert("Authorization", HeaderValue::from_str(&format!("Token {}", key)).map_err(|e| e.to_string())?);
    let (ws, _) = tokio::time::timeout(std::time::Duration::from_secs(30), connect_async(request))
        .await.map_err(|_| "Vidu WebSocket 连接超时，请检查网络后重试".to_string())?
        .map_err(|e| format!("Vidu WebSocket 连接失败: {e}"))?;
    let (mut writer, mut reader) = ws.split();
    let (sender, mut receiver) = unbounded_channel::<Outbound>();
    let init = json!({"type":1,"live_id":live_id,"conn_id":conn_id,"seq_id":1,"payload":{"conn_init":{"version":1}}});
    writer.send(Message::Text(init.to_string().into())).await.map_err(|e| e.to_string())?;
    let snapshot = SessionSnapshot { live_id: live_id.clone(), rtc: rtc.clone(), voice_provider: avatar.voice_provider.clone() };
    *state.session.lock().map_err(|e| e.to_string())? = Some(Session { live_id: live_id.clone(), conn_id, key, region, rtc, sender, seq: 100, last_video_frame_ms: unix_ms(), voice_provider: avatar.voice_provider.clone() });
    let _ = app.emit("session-changed", snapshot.clone());
    let app_for_task = app.clone();
    let task_live_id = live_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut retries = 0_u64;
        let mut heartbeat = tokio::time::interval_at(tokio::time::Instant::now() + std::time::Duration::from_secs(10), std::time::Duration::from_secs(10));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut forced = false;
        let mut ready_at = None;
        let started_at = tokio::time::Instant::now();
        let mut playback_check = tokio::time::interval(std::time::Duration::from_secs(3));
        loop {
            tokio::select! {
                _ = playback_check.tick() => {
                    let last_frame = app_for_task.state::<AppState>().session.lock().ok()
                        .and_then(|guard| guard.as_ref().filter(|s| s.live_id == task_live_id).map(|s| s.last_video_frame_ms));
                    let Some(last_frame) = last_frame else { break; };
                    if playback_expired(started_at.elapsed().as_secs(), ready_at.map(|at: tokio::time::Instant| at.elapsed().as_secs()), unix_ms().saturating_sub(last_frame)) {
                        let _ = app_for_task.emit("playback-failed", json!({"live_id": task_live_id, "error": if ready_at.is_some() { "30 秒未收到可播放的视频画面，正在自动挂断以避免持续计费" } else { "90 秒内初始化未完成，正在自动挂断" }}));
                        let cleanup_app = app_for_task.clone();
                        let cleanup_id = task_live_id.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) = end_session(cleanup_app.clone(), cleanup_app.state::<AppState>(), Some(cleanup_id)).await {
                                let _ = cleanup_app.emit("session-cleanup-error", error);
                            }
                        });
                        // Keep the socket alive so end_session can send and confirm the hangup.
                        playback_check = tokio::time::interval_at(tokio::time::Instant::now() + std::time::Duration::from_secs(30), std::time::Duration::from_secs(30));
                    }
                }
                _ = heartbeat.tick() => {
                    if writer.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
                }
                outgoing = receiver.recv() => {
                    match outgoing {
                        Some(outbound) => {
                            let result = writer.send(outbound.message).await.map_err(|e| e.to_string());
                            let failed = result.is_err();
                            if let Some(written) = outbound.written { let _ = written.send(result); }
                            if failed { break; }
                        }
                        None => break,
                    }
                }
                incoming = reader.next() => {
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            if let Some(value) = session_signal(&text, &task_live_id) {
                                if value.pointer("/payload/conn_init_ack/success").and_then(Value::as_bool) == Some(true) && ready_at.is_none() {
                                    ready_at = Some(tokio::time::Instant::now());
                                }
                                if value.get("type").and_then(Value::as_u64) == Some(6) { forced = true; }
                                if value.get("type").and_then(Value::as_u64) == Some(2)
                                    && value.pointer("/payload/conn_init_ack/error_code").and_then(Value::as_str) == Some("NOT_READY")
                                    && retries < 20 {
                                    retries += 1;
                                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                                    let retry = json!({"type":1,"live_id":value.get("live_id"),"conn_id":value.get("conn_id"),"seq_id":retries+1,"payload":{"conn_init":{"version":1}}});
                                    if writer.send(Message::Text(retry.to_string().into())).await.is_err() { break; }
                                }
                                let _ = app_for_task.emit("vidu-signal", value);
                                if forced { break; }
                            }
                        }
                        Some(Ok(Message::Ping(data))) => { if writer.send(Message::Pong(data)).await.is_err() { break; } }
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        _ => {}
                    }
                }
            }
        }
        if forced {
            if let Ok(mut guard) = app_for_task.state::<AppState>().session.lock() {
                if guard.as_ref().is_some_and(|session| session.live_id == task_live_id) { guard.take(); }
            }
            let _ = app_for_task.emit("session-ended", ());
        }
        let _ = writer.close().await;
        let _ = app_for_task.emit("vidu-disconnected", json!({"live_id":task_live_id,"forced":forced}));
        if !forced {
            if let Err(error) = end_session(app_for_task.clone(), app_for_task.state::<AppState>(), Some(task_live_id)).await {
                let _ = app_for_task.emit("session-cleanup-error", error);
            }
        }
    });
    Ok(snapshot)
}

fn send_signal(session: &mut Session, kind: u64, payload: Value) -> Result<(), String> {
    session.seq += 1;
    let message = json!({"type":kind,"live_id":session.live_id,"conn_id":session.conn_id,"seq_id":session.seq,"payload":payload});
    session.sender.send(Outbound { message: Message::Text(message.to_string().into()), written: None }).map_err(|e| e.to_string())
}

#[tauri::command]
fn speak_text(state: State<'_, AppState>, live_id: String, content: String) -> Result<(), String> {
    let content = content.trim();
    if content.is_empty() { return Err("播报文本不能为空".into()); }
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = guard.as_mut().filter(|session| session.live_id == live_id).ok_or("原会话已结束，已取消本次播报")?;
    if session.voice_provider != "doubao" { return Err("指定台词播报需要豆包音色供应商，请结束会话后改为豆包再创建数字人".into()); }
    send_signal(session, 100, json!({"text_tts":{"msg_id":uuid::Uuid::new_v4().to_string(),"content":content}}))
}

fn gift_action_payload(task_id: &str, gesture: &str) -> Result<Value, String> {
    let content = match gesture {
        "heart" => "面向镜头，微笑着双手在胸前做一个比心动作，表达收到礼物后的开心和感谢。",
        "kiss" => "面向镜头，微笑着轻吻自己的指尖，做一个可爱的亲吻手势，表达对观众礼物的感谢。",
        "flying_kiss" => "面向镜头，微笑着将手指轻触嘴唇，然后向镜头送出一个飞吻，表达对观众礼物的感谢。",
        _ => return Err("不支持的礼物动作".into()),
    };
    if task_id.trim().is_empty() { return Err("动作缺少互动任务 ID".into()); }
    Ok(json!({"text_action":{"msg_id":format!("gift-action-{task_id}"),"content":content}}))
}

#[tauri::command]
fn send_avatar_action(state: State<'_, AppState>, live_id: String, task_id: String, gesture: String) -> Result<(), String> {
    let payload = gift_action_payload(&task_id, &gesture)?;
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = guard.as_mut().filter(|session| session.live_id == live_id).ok_or("原会话已结束，已取消本次动作")?;
    send_signal(session, 101, payload)
}

#[tauri::command]
fn send_question(state: State<'_, AppState>, content: String) -> Result<(), String> {
    let content = content.trim();
    if content.is_empty() { return Err("请输入问题".into()); }
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = guard.as_mut().ok_or("Vidu 会话尚未启动")?;
    send_signal(session, 99, json!({"text_msg":{"msg_id":uuid::Uuid::new_v4().to_string(),"content":content,"timestamp":unix_ms()}}))
}

#[tauri::command]
fn interrupt_session(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = guard.as_mut().ok_or("Vidu 会话尚未启动")?;
    send_signal(session, 7, json!({}))
}

async fn reconnect_and_hangup(key: &str, region: &str, live_id: &str, conn_id: &str, seq: u64) -> Result<(), String> {
    let url = format!("{}/live/ws/live/connect?live_id={}&conn_id={}", ws_host(region), live_id, conn_id);
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert("Authorization", HeaderValue::from_str(&format!("Token {}", key)).map_err(|e| e.to_string())?);
    let (mut ws, _) = tokio::time::timeout(std::time::Duration::from_secs(8), connect_async(request))
        .await.map_err(|_| "重新连接 Vidu 控制通道超时".to_string())?
        .map_err(|e| format!("重新连接 Vidu 控制通道失败：{e}"))?;
    let init = json!({"type":1,"live_id":live_id,"conn_id":conn_id,"seq_id":seq,"payload":{"conn_init":{"version":1}}});
    ws.send(Message::Text(init.to_string().into())).await.map_err(|e| e.to_string())?;
    let hangup = json!({"type":5,"live_id":live_id,"conn_id":conn_id,"seq_id":seq+1,"payload":{"hangup":{"hangup_reason":"user_end"}}});
    ws.send(Message::Text(hangup.to_string().into())).await.map_err(|e| e.to_string())?;
    let _ = ws.close(None).await;
    Ok(())
}

#[tauri::command]
async fn end_session(app: tauri::AppHandle, state: State<'_, AppState>, live_id: Option<String>) -> Result<(), String> {
    let current = {
        let mut guard = state.session.lock().map_err(|e| e.to_string())?;
        guard.as_mut().filter(|session| live_id.as_ref().is_none_or(|id| *id == session.live_id)).map(|session| {
            session.seq += 1;
            let message = json!({"type":5,"live_id":session.live_id,"conn_id":session.conn_id,"seq_id":session.seq,"payload":{"hangup":{"hangup_reason":"user_end"}}});
            (session.live_id.clone(), session.conn_id.clone(), session.key.clone(), session.region.clone(), session.seq, session.sender.clone(), Message::Text(message.to_string().into()))
        })
    };
    if let Some((live_id, conn_id, key, region, seq, sender, message)) = current {
        let (written, received) = oneshot::channel();
        let sent = sender.send(Outbound { message, written: Some(written) }).is_ok()
            && matches!(tokio::time::timeout(std::time::Duration::from_secs(5), received).await, Ok(Ok(Ok(()))));
        if !sent {
            reconnect_and_hangup(&key, &region, &live_id, &conn_id, seq + 1).await?;
        }
        let mut final_live = None;
        for _ in 0..10 {
            let result = live_status(key.clone(), region.clone(), live_id.clone()).await?;
            if result.pointer("/live/status").and_then(Value::as_str) == Some("ended") { final_live = result.get("live").cloned(); break; }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        let final_live = final_live.ok_or("已发送挂断，但 Vidu 尚未确认 ended；请重试结束会话")?;
        let mut guard = state.session.lock().map_err(|e| e.to_string())?;
        if guard.as_ref().is_some_and(|session| session.live_id == live_id) { guard.take(); }
        let _ = app.emit("session-ended", json!({"live_id":live_id,"live":final_live}));
    }
    Ok(())
}

#[tauri::command]
fn playback_frame(state: State<'_, AppState>, live_id: String) -> Result<(), String> {
    if let Some(session) = state.session.lock().map_err(|e| e.to_string())?.as_mut().filter(|s| s.live_id == live_id) {
        session.last_video_frame_ms = unix_ms();
    }
    Ok(())
}

#[tauri::command]
fn session_snapshot(state: State<'_, AppState>) -> Result<Option<SessionSnapshot>, String> {
    Ok(state.session.lock().map_err(|e| e.to_string())?.as_ref().map(|s| SessionSnapshot { live_id: s.live_id.clone(), rtc: s.rtc.clone(), voice_provider: s.voice_provider.clone() }))
}

#[tauri::command]
async fn live_status(key: String, region: String, live_id: String) -> Result<Value, String> {
    let key = normalized_key(&key)?;
    if live_id.is_empty() || !live_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("无效的 Vidu 会话 ID".into());
    }
    let response = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| e.to_string())?
        .get(format!("{}/live/v1/lives/{}", api_host(&region), live_id))
        .header("Authorization", format!("Token {}", key))
        .send().await.map_err(|e| e.to_string())?;
    response_json(response).await
}

#[tauri::command]
async fn open_obs_window(app: tauri::AppHandle) -> Result<(), String> {
    // WebView2 window creation deadlocks inside synchronous Windows commands.
    // Keep this command async so construction runs outside the UI event callback.
    if let Some(window) = app.get_webview_window("obs") { window.set_focus().map_err(|e| e.to_string())?; return Ok(()); }
    WebviewWindowBuilder::new(&app, "obs", WebviewUrl::App("index.html?view=obs".into()))
        .title("数字人画面 · OBS 窗口").inner_size(1080.0, 1920.0).min_inner_size(360.0, 640.0)
        .build().map_err(|e| e.to_string())?;
    Ok(())
}

fn dyhub_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let resource = app.path().resource_dir().map_err(|e| e.to_string())?;
    let packaged = resource.join("dyhub");
    let node = resource.join("node.exe");
    if packaged.join("dist/index.js").exists() && node.exists() { return Ok((packaged, node)); }
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/dyhub");
    if source.join("dist/index.js").exists() { return Ok((source, PathBuf::from("node"))); }
    Err("未找到 dyhub 构建产物。请先运行 npm run prepare:dyhub".into())
}

#[tauri::command]
async fn start_dyhub(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    {
        let mut guard = state.dyhub.lock().map_err(|e| e.to_string())?;
        if let Some(child) = guard.as_mut() {
            if child.try_wait().map_err(|e| e.to_string())?.is_none() { return Ok("running".into()); }
            *guard = None;
        }
    }
    if reqwest::get("http://127.0.0.1:8757/api/stats").await.is_ok() { return Ok("external".into()); }
    let (dir, node) = dyhub_paths(&app)?;
    let mut command = Command::new(node);
    command.arg(dir.join("dist/index.js")).current_dir(&dir)
        .env("DYHUB_HOST", "127.0.0.1").env("DYHUB_PORT", "8757")
        .env("DYHUB_COLLECTOR", "browser").stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let child = command.spawn().map_err(|e| format!("启动 dyhub 失败: {e}"))?;
    *state.dyhub.lock().map_err(|e| e.to_string())? = Some(child);
    for _ in 0..30 {
        if reqwest::get("http://127.0.0.1:8757/api/stats").await.is_ok() { return Ok("running".into()); }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Err("dyhub 启动超时，请检查本机 Chrome 和端口 8757".into())
}

#[tauri::command]
fn stop_dyhub(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(mut child) = state.dyhub.lock().map_err(|e| e.to_string())?.take() {
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"])
                .creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
async fn dyhub_connect(room_id: String) -> Result<Value, String> {
    let room_id = room_id.trim();
    if room_id.is_empty() { return Err("请输入直播间号".into()); }
    let response = reqwest::Client::new().post("http://127.0.0.1:8757/api/rooms/connect")
        .json(&json!({"roomId":room_id})).send().await.map_err(|e| e.to_string())?;
    response_json(response).await
}

#[tauri::command]
async fn dyhub_disconnect(room_id: String) -> Result<Value, String> {
    let response = reqwest::Client::new().post(format!("http://127.0.0.1:8757/api/rooms/{}/disconnect", room_id))
        .send().await.map_err(|e| e.to_string())?;
    response_json(response).await
}

#[tauri::command]
async fn clone_tts_voice(key: String, region: String, voice_id: String, audio_url: String, text: String) -> Result<Value, String> {
    let key = normalized_key(&key)?;
    if voice_id.trim().is_empty() || audio_url.trim().is_empty() || text.trim().is_empty() {
        return Err("请填写音色名称、参考音频 URL 和试听文本".into());
    }
    let client = reqwest::Client::new();
    let response = client.post(format!("{}/ent/v2/audio-clone", api_host(&region)))
        .header("Authorization", format!("Token {}", key))
        .json(&json!({"voice_id":voice_id,"audio_url":audio_url,"text":text}))
        .send().await.map_err(|e| e.to_string())?;
    let data = match response_json(response).await {
        Err(error) if error.contains("CreditInsufficient") => Err("Vidu 账户积分不足，无法克隆试听音色。请在 Vidu 控制台检查余额。".into()),
        result => result,
    }?;
    if data.get("state").and_then(Value::as_str) == Some("success") { return Ok(data); }
    if data.get("state").and_then(Value::as_str) == Some("failed") {
        return Err(format!("Vidu 试听音色克隆失败：{}", data.get("err_code").and_then(Value::as_str).unwrap_or("未知原因")));
    }
    let task_id = data.get("task_id").and_then(Value::as_str).ok_or("Vidu 试听音色响应缺少任务 ID")?;
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let response = client.get(format!("{}/ent/v2/tasks/{}/creations", api_host(&region), task_id))
            .header("Authorization", format!("Token {}", key))
            .send().await.map_err(|e| e.to_string())?;
        let result = response_json(response).await?;
        match result.get("state").and_then(Value::as_str) {
            Some("success") => return Ok(json!({"state":"success","voice_id":voice_id,"demo_audio":result.pointer("/creations/0/url").and_then(Value::as_str).unwrap_or("")})),
            Some("failed") => return Err(format!("Vidu 试听音色克隆失败：{}", result.get("err_code").and_then(Value::as_str).unwrap_or("未知原因"))),
            _ => {}
        }
    }
    Err(format!("Vidu 试听音色仍在处理中，任务 ID：{}。请稍后再试。", task_id))
}

#[tauri::command]
async fn clone_live_voice(key: String, region: String, voice: String, audio_url: String, transcript: String) -> Result<Value, String> {
    let key = normalized_key(&key)?;
    if voice.trim().is_empty() || audio_url.trim().is_empty() { return Err("请填写音色名称和可访问的音频 URL".into()); }
    if audio_url.chars().count() > 2048 { return Err("audio_url 超过 Vidu 的 2048 字符上限，请使用可访问的音频 URL".into()); }
    let mut body = json!({"voice":voice,"audio_url":audio_url,"language":"zh","provider":"doubao"});
    if !transcript.trim().is_empty() { body["text"] = json!(transcript.trim()); }
    let response = reqwest::Client::new().post(format!("{}/live/v1/voices/clone", api_host(&region)))
        .header("Authorization", format!("Token {}", key))
        .json(&body)
        .send().await.map_err(|e| e.to_string())?;
    response_json(response).await
}

#[tauri::command]
async fn list_voices(key: String, region: String) -> Result<Value, String> {
    let key = normalized_key(&key)?;
    let response = reqwest::Client::new().get(format!("{}/live/v1/voices", api_host(&region)))
        .header("Authorization", format!("Token {}", key)).send().await.map_err(|e| e.to_string())?;
    response_json(response).await
}

#[tauri::command]
async fn account_credits(key: String, region: String) -> Result<Value, String> {
    let key = normalized_key(&key)?;
    let response = reqwest::Client::new().get(format!("{}/ent/v2/credits", api_host(&region)))
        .header("Authorization", format!("Token {}", key))
        .query(&[("show_detail", "true")])
        .send().await.map_err(|e| e.to_string())?;
    response_json(response).await
}

#[tauri::command]
async fn delete_voice(key: String, region: String, voice: String) -> Result<(), String> {
    let key = normalized_key(&key)?;
    if voice.is_empty() || !voice.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
        return Err("音色名称无效".into());
    }
    let response = reqwest::Client::new().delete(format!("{}/live/v1/voices/{}", api_host(&region), voice))
        .header("Authorization", format!("Token {}", key))
        .send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.map_err(|e| e.to_string())?;
        return Err(format!("Vidu HTTP {}: {}", status, body));
    }
    Ok(())
}

#[tauri::command]
async fn preview_voice(key: String, region: String, voice_id: String, text: String) -> Result<String, String> {
    let key = normalized_key(&key)?;
    if voice_id.trim().is_empty() { return Err("该直播音色尚未关联语音合成音色".into()); }
    let text = text.trim();
    if text.is_empty() || text.chars().count() > 200 { return Err("试听文本需为 1 到 200 个字".into()); }
    let client = reqwest::Client::new();
    let response = client.post(format!("{}/ent/v2/audio-tts", api_host(&region)))
        .header("Authorization", format!("Token {}", key))
        .json(&json!({"text":text,"voice_setting_voice_id":voice_id}))
        .send().await.map_err(|e| e.to_string())?;
    let data = match response_json(response).await {
        Err(error) if error.contains("CreditInsufficient") => return Err("Vidu 账户积分不足，无法生成试听音频。请在 Vidu 控制台检查余额。".into()),
        result => result?,
    };
    if let Some(url) = data.get("file_url").and_then(Value::as_str).filter(|url| !url.is_empty()) { return Ok(url.to_string()); }
    let task_id = data.get("task_id").and_then(Value::as_str).ok_or("Vidu 试听响应缺少音频地址和任务 ID")?;
    for _ in 0..15 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let response = client.get(format!("{}/ent/v2/tasks/{}/creations", api_host(&region), task_id))
            .header("Authorization", format!("Token {}", key))
            .send().await.map_err(|e| e.to_string())?;
        let result = response_json(response).await?;
        if let Some(url) = result.pointer("/creations/0/url").and_then(Value::as_str).filter(|url| !url.is_empty()) { return Ok(url.to_string()); }
        if result.get("state").and_then(Value::as_str) == Some("failed") {
            return Err(format!("Vidu 试听生成失败：{}", result.get("err_code").and_then(Value::as_str).unwrap_or("未知原因")));
        }
    }
    Err("Vidu 试听生成超时，请稍后重试".into())
}

fn main() {
    #[cfg(windows)]
    let Some(_instance_guard) = single_instance::Guard::acquire() else { return; };
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(queue_store::QueueStorage::default())
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let app = window.app_handle().clone();
                    let live_id = app.state::<AppState>().session.lock().ok().and_then(|guard| guard.as_ref().map(|s| s.live_id.clone()));
                    if let Some(live_id) = live_id {
                        api.prevent_close();
                        tauri::async_runtime::spawn(async move {
                            match end_session(app.clone(), app.state::<AppState>(), Some(live_id)).await {
                                Ok(()) => { if let Some(main) = app.get_webview_window("main") { let _ = main.close(); } }
                                Err(error) => { let _ = app.emit("session-cleanup-error", error); }
                            }
                        });
                    }
                }
            }
            if window.label() == "obs" && matches!(event, tauri::WindowEvent::Destroyed) {
                let app = window.app_handle().clone();
                let live_id = app.state::<AppState>().session.lock().ok().and_then(|guard| guard.as_ref().map(|s| s.live_id.clone()));
                if let Some(live_id) = live_id {
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = end_session(app.clone(), app.state::<AppState>(), Some(live_id)).await {
                            let _ = app.emit("session-cleanup-error", error);
                        }
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![create_session, send_question, interrupt_session, end_session, session_snapshot, playback_frame, live_status, open_obs_window, start_dyhub, stop_dyhub, dyhub_connect, dyhub_disconnect, clone_tts_voice, clone_live_voice, list_voices, account_credits, delete_voice, preview_voice, speak_text, send_avatar_action, model_api::list_models, model_api::generate_reply, model_api::generate_interaction, queue_store::queue_load, queue_store::queue_commit, queue_store::queue_archive_event, queue_store::queue_ack_event, queue_store::queue_save_config])
        .run(tauri::generate_context!())
        .expect("Tauri application failed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcription_frames_are_bound_to_the_socket_session() {
        let frame = r#"{"payload":{"text_msg":{"content":"你好，请问你可以帮我做什么？"}},"type":9}"#;
        let signal = session_signal(frame, "live-123").unwrap();
        assert_eq!(signal["live_id"], "live-123");
        assert_eq!(signal["type"], 9);
        assert_eq!(signal["payload"]["text_msg"]["content"], "你好，请问你可以帮我做什么？");
        assert_eq!(session_signal(r#"{"type":10,"live_id":"wrong"}"#, "live-123").unwrap()["live_id"], "live-123");
        assert!(session_signal("[]", "live-123").is_none());
        assert!(session_signal("invalid", "live-123").is_none());
    }

    #[test]
    fn playback_guard_allows_warmup_and_requires_recent_frames_after_ready() {
        assert!(!playback_expired(89, None, 89_000));
        assert!(playback_expired(90, None, 90_000));
        assert!(!playback_expired(100, Some(29), 100_000));
        assert!(playback_expired(100, Some(30), 30_000));
        assert!(!playback_expired(7200, Some(7100), 1000));
        assert!(playback_expired(7200, Some(7100), 30_000));
    }

    #[test]
    fn only_one_create_request_can_hold_the_guard() {
        let flag = AtomicBool::new(false);
        let first = CreateSessionGuard::acquire(&flag).unwrap();
        assert!(CreateSessionGuard::acquire(&flag).is_err());
        drop(first);
        assert!(CreateSessionGuard::acquire(&flag).is_ok());
    }

    #[test]
    fn gift_actions_use_separate_text_action_signals_with_stable_task_ids() {
        for (gesture, expected) in [("heart", "比心"), ("kiss", "亲吻"), ("flying_kiss", "飞吻")] {
            let payload = gift_action_payload("task-1", gesture).unwrap();
            assert_eq!(payload["text_action"]["msg_id"], "gift-action-task-1");
            assert!(payload["text_action"]["content"].as_str().unwrap().contains(expected));
            assert!(payload.get("text_tts").is_none());
        }
        assert!(gift_action_payload("task-1", "untrusted_action").is_err());
        assert!(gift_action_payload("", "heart").is_err());
    }
}
