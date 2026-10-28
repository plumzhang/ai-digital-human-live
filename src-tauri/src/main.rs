#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod model_api;
mod obs_window;
mod queue_store;
mod signal_trace;
mod tts_log;
mod songs;
mod song_director;
mod whisper;
mod speech_runtime;
mod speech_stt;
mod speech_text;
mod component;
mod component_action;
mod prepared_speech;

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
    ready: bool,
    speaking: bool,
    external_audio: Option<(String, u64)>,
    conversation: Vec<Value>,
    speech_cancel: tokio::sync::watch::Sender<u64>,
    tts: component::TtsConfig,
    llm: component::LlmConfig,
    persona: String,
}

struct Outbound {
    message: Message,
    written: Option<oneshot::Sender<Result<(), String>>>,
    epoch: Option<(tokio::sync::watch::Receiver<u64>, u64)>,
}

// Bound every write, including heartbeats: a stalled socket must not prevent
// the control loop from reading errors or reporting later lyrics as unsent.
async fn write_control<W>(writer: &mut W, message: Message) -> Result<(), String>
where W: futures_util::Sink<Message> + Unpin, W::Error: std::fmt::Display {
    tokio::time::timeout(std::time::Duration::from_secs(3), writer.send(message)).await
        .map_err(|_| "控制连接写入超时".to_string())?
        .map_err(|error| error.to_string())
}

#[derive(Serialize, Clone)]
struct SessionSnapshot { live_id: String, rtc: Value, voice_provider: String }

#[derive(Deserialize)]
struct AvatarSettings {
    tts: component::TtsConfig,
    llm: component::LlmConfig,
    #[serde(default)]
    model: Option<String>,
    image_uri: String,
    persona: String,
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
    signal.as_object_mut()?.insert("received_at".into(), json!(unix_ms()));
    Some(signal)
}

fn avatar_model(model: Option<&str>) -> Result<&'static str, String> {
    match model {
        None | Some("vidu-s2") => Ok("vidu-s2"),
        Some("vidu-s1") => Ok("vidu-s1"),
        _ => Err("数字人模型无效，请选择 vidu-s2 或 vidu-s1".into()),
    }
}

#[tauri::command]
async fn create_session(app: tauri::AppHandle, state: State<'_, AppState>, key: String, region: String, avatar: AvatarSettings) -> Result<SessionSnapshot, String> {
    let _creation_guard = CreateSessionGuard::acquire(&state.creating_session)?;
    if state.session.lock().map_err(|e| e.to_string())?.is_some() { return Err("已有运行中的 Vidu 会话，请先结束".into()); }
    let key = normalized_key(&key)?;
    let model = avatar_model(avatar.model.as_deref())?;
    if avatar.image_uri.trim().is_empty() || avatar.persona.trim().is_empty() { return Err("请填写形象图片和人设".into()); }
    component::validate(&avatar.tts, &avatar.llm)?;
    component::component_preflight(avatar.tts.clone()).await?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(90))
        .build().map_err(|e| e.to_string())?;
    let body = json!({"model":model,"image_uri":avatar.image_uri,"managed_rtc":{"provider":"artc"},"action":{"enabled":true,"library_id":"0"}});
    let response = client.post(format!("{}/live/s_avatar/component", api_host(&region)))
        .header("Authorization", format!("Token {}", key)).json(&body).send().await.map_err(|e| e.to_string())?;
    let data = response_json(response).await?;
    let live_id = data.pointer("/live/id").and_then(Value::as_str).ok_or("Vidu 响应缺少 live.id")?.to_string();
    let rtc = data.get("managed_rtc").cloned().ok_or("Vidu 响应缺少 RTC 凭证")?;
    let _ = app.emit("live-created", json!({"live_id": live_id, "status": data.pointer("/live/status")}));
    let conn_id = format!("desktop-{}", uuid::Uuid::new_v4());
    let url = format!("{}/live/v1/external-lives/{}/stream?conn_id={}", ws_host(&region), live_id, conn_id);
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert("Authorization", HeaderValue::from_str(&format!("Token {}", key)).map_err(|e| e.to_string())?);
    let (sender, mut receiver) = unbounded_channel::<Outbound>();
    let snapshot = SessionSnapshot { live_id: live_id.clone(), rtc: rtc.clone(), voice_provider: "qwen3_tts".into() };
    let task_conn_id = conn_id.clone();
    *state.session.lock().map_err(|e| e.to_string())? = Some(Session { live_id: live_id.clone(), conn_id: conn_id.clone(), key, region, rtc, sender, seq: 100, last_video_frame_ms: unix_ms(), voice_provider: "qwen3_tts".into(), ready: false, speaking: false, external_audio: None, conversation: Vec::new(), speech_cancel: tokio::sync::watch::channel(0).0, tts: avatar.tts, llm: avatar.llm, persona: avatar.persona });
    // Retain the live ID before connecting so a failed handshake can still be
    // ended and cannot silently leave an untracked billable session behind.
    let _ = app.emit("session-changed", snapshot.clone());
    let connection = tokio::time::timeout(std::time::Duration::from_secs(30), connect_async(request)).await;
    let (ws, _) = match connection {
        Ok(Ok(connection)) => connection,
        failure => {
            drop(receiver);
            let reason = match failure { Ok(Err(error)) => format!("Vidu WebSocket 连接失败：{error}"), _ => "Vidu WebSocket 连接超时".into() };
            let cleanup = end_session(app.clone(), state.clone(), Some(live_id)).await;
            return Err(format!("{reason}{}", cleanup.err().map(|error| format!("；会话尚未确认结束，请重试结束会话：{error}")).unwrap_or_default()));
        }
    };
    let (mut writer, mut reader) = ws.split();
    let init = json!({"type":1,"live_id":live_id,"conn_id":conn_id,"seq_id":1,"payload":{"conn_init":{"version":1}}});
    if let Err(error) = write_control(&mut writer, Message::Text(init.to_string().into())).await {
        drop(receiver); drop(writer); drop(reader);
        let cleanup = end_session(app.clone(), state.clone(), Some(live_id)).await;
        return Err(format!("{error}{}", cleanup.err().map(|error| format!("；请重试结束会话：{error}")).unwrap_or_default()));
    }
    let app_for_task = app.clone();
    let task_live_id = live_id.clone();
    tauri::async_runtime::spawn(async move {
        signal_trace::record(&app_for_task, &task_live_id, "connected", &json!({}));
        let mut retries = 0_u64;
        let mut heartbeat = tokio::time::interval_at(tokio::time::Instant::now() + std::time::Duration::from_secs(10), std::time::Duration::from_secs(10));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut forced = false;
        let mut initialized = false;
        let initialization_timeout = tokio::time::sleep(std::time::Duration::from_secs(60));
        tokio::pin!(initialization_timeout);
        loop {
            tokio::select! {
                _ = &mut initialization_timeout, if !initialized => { let _ = app_for_task.emit("session-cleanup-error", "组件初始化超过60秒，正在结束会话"); break; }
                _ = heartbeat.tick() => {
                    if write_control(&mut writer, Message::Ping(Vec::new().into())).await.is_err() { break; }
                }
                outgoing = receiver.recv() => {
                    match outgoing {
                        Some(outbound) => {
                            if outbound.epoch.as_ref().is_some_and(|(receiver, epoch)| *receiver.borrow() != *epoch) {
                                if let Some(written) = outbound.written { let _ = written.send(Err("播报已取消".into())); }
                                continue;
                            }
                            let metadata = match &outbound.message { Message::Text(text) => serde_json::from_str::<Value>(text).unwrap_or(Value::Null), _ => Value::Null };
                            let result = write_control(&mut writer, outbound.message).await;
                            let failed = result.is_err();
                            if !metadata.is_null() || failed { signal_trace::record(&app_for_task, &task_live_id, if failed { "write_failed" } else { "written" }, &metadata); }
                            tts_log::record(&app_for_task, &task_live_id, &metadata, result.as_ref().err().map(String::as_str));
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
                                if matches!(value["type"].as_u64(), Some(2 | 6 | 103)) { signal_trace::record(&app_for_task, &task_live_id, "received", &value); }
                                if value["type"].as_u64() == Some(103) { tts_log::record_rejection(&app_for_task, &task_live_id, &value); }
                                if value.get("type").and_then(Value::as_u64) == Some(6) { forced = true; }
                                if value.get("type").and_then(Value::as_u64) == Some(2)
                                    && value.pointer("/payload/conn_init_ack/error_code").and_then(Value::as_str) == Some("NOT_READY")
                                    && retries < 20 {
                                    retries += 1;
                                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                                    let retry = json!({"type":1,"live_id":value.get("live_id"),"conn_id":task_conn_id,"seq_id":retries+1,"payload":{"conn_init":{"version":1}}});
                                    if write_control(&mut writer, Message::Text(retry.to_string().into())).await.is_err() { break; }
                                }
                                if value["type"].as_u64() == Some(2) && value.pointer("/payload/conn_init_ack/success").and_then(Value::as_bool) == Some(true) {
                                    initialized = true;
                                    if let Ok(mut guard) = app_for_task.state::<AppState>().session.lock() {
                                        if let Some(session) = guard.as_mut().filter(|s| s.live_id == task_live_id) { session.ready = true; }
                                    }
                                }
                                let _ = app_for_task.emit("vidu-signal", value);
                                if forced { break; }
                            }
                        }
                        Some(Ok(Message::Ping(data))) => { if write_control(&mut writer, Message::Pong(data)).await.is_err() { break; } }
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        _ => {}
                    }
                }
            }
        }
        if let Ok(mut guard) = app_for_task.state::<AppState>().session.lock() {
            if let Some(session) = guard.as_mut().filter(|s| s.live_id == task_live_id) { session.ready = false; session.speaking = false; session.speech_cancel.send_modify(|value| *value += 1); }
        }
        // Pending instructions were never written when the connection closed.
        receiver.close();
        while let Ok(outbound) = receiver.try_recv() {
            if let Message::Text(text) = &outbound.message {
                if let Ok(signal) = serde_json::from_str::<Value>(text) {
                    tts_log::record(&app_for_task, &task_live_id, &signal, Some("控制连接已关闭，指令未发送"));
                }
            }
            if let Some(written) = outbound.written { let _ = written.send(Err("控制连接已关闭".into())); }
        }
        signal_trace::record(&app_for_task, &task_live_id, if forced { "forced_closed" } else { "socket_closed" }, &json!({}));
        if forced {
            if let Ok(mut guard) = app_for_task.state::<AppState>().session.lock() {
                if guard.as_ref().is_some_and(|session| session.live_id == task_live_id) { guard.take(); }
            }
            let _ = app_for_task.emit("session-ended", json!({"live_id":task_live_id}));
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), writer.close()).await;
        let _ = app_for_task.emit("vidu-disconnected", json!({"live_id":task_live_id,"forced":forced}));
        if !forced {
            if let Err(error) = end_session(app_for_task.clone(), app_for_task.state::<AppState>(), Some(task_live_id)).await {
                let _ = app_for_task.emit("session-cleanup-error", error);
            }
        }
    });
    Ok(snapshot)
}

fn send_signal(app: &tauri::AppHandle, session: &mut Session, kind: u64, payload: Value) -> Result<(), String> {
    queue_signal(app, session, kind, payload, None)
}

fn queue_signal(app: &tauri::AppHandle, session: &mut Session, kind: u64, payload: Value, written: Option<oneshot::Sender<Result<(), String>>>) -> Result<(), String> {
    session.seq += 1;
    let message = json!({"type":kind,"live_id":session.live_id,"conn_id":session.conn_id,"seq_id":session.seq,"payload":payload});
    session.sender.send(Outbound { message: Message::Text(message.to_string().into()), written, epoch: None }).map_err(|error| {
        tts_log::record(app, &session.live_id, &message, Some("控制连接已关闭，指令未发送"));
        error.to_string()
    })
}

#[cfg(test)]
fn speech_message_signal(content: &str, task_id: Option<String>) -> Result<(u64, Value), String> {
    let content = content.trim();
    if content.is_empty() { return Err("播报文本不能为空".into()); }
    // Retain task IDs so lyric observations and service errors still correlate.
    let msg_id = task_id.filter(|id| !id.trim().is_empty()).map(|id| format!("tts-{id}")).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    Ok((99, json!({"text_msg":{"msg_id":msg_id,"content":content,"timestamp":unix_ms()}})))
}

#[tauri::command]
async fn speak_text(app: tauri::AppHandle, state: State<'_, AppState>, live_id: String, content: String, task_id: Option<String>) -> Result<(), String> {
    let _ = state;
    component::run(app, live_id, content, task_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()), false).await
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
async fn send_avatar_action(app: tauri::AppHandle, state: State<'_, AppState>, live_id: String, task_id: String, gesture: Option<String>, instruction: Option<String>) -> Result<(), String> {
    let payload = avatar_action_payload(&task_id, gesture.as_deref(), instruction.as_deref())?;
    let receipts = {
        let mut guard = state.session.lock().map_err(|e| e.to_string())?;
        let session = guard.as_mut().filter(|s| s.live_id == live_id).ok_or("原会话已结束，动作未发送")?;
        component_action::enqueue(session, payload)?
    };
    let result = component_action::wait(receipts).await;
    if let Err(error) = &result { let _ = app.emit("component-action-error", json!({"live_id":live_id,"task_id":task_id,"error":error})); }
    result
}

fn avatar_action_payload(task_id: &str, gesture: Option<&str>, instruction: Option<&str>) -> Result<Value, String> {
    if let Some(instruction) = instruction {
        let instruction = instruction.trim();
        if task_id.trim().is_empty() { return Err("动作缺少互动任务 ID".into()); }
        if instruction.is_empty() || instruction.chars().count() > 300 || instruction.chars().any(char::is_control) {
            return Err("动作描述需为1–300字且不能包含控制字符".into());
        }
        return Ok(json!({"text_action":{"msg_id":format!("avatar-action-{task_id}"),"content":format!("{instruction} 动作自然连贯，完成后回到面对镜头的自然姿态。只做动作，不要说话。")}}));
    }
    gift_action_payload(task_id, gesture.unwrap_or("none"))
}

fn handoff_action_payload(task_id: &str, direction: &str, angle_deg: u16) -> Result<Value, String> {
    if task_id.trim().is_empty() { return Err("承接动作缺少互动任务 ID".into()); }
    if angle_deg > 90 { return Err("承接动作查看角度需为0–90度".into()); }
    let content = match direction {
        "left_down" => format!("头部与视线朝向左下角，向左下方斜向下{angle_deg}度查看，像在查看左下方手机上的新消息。动作自然流畅，保持放松，随后自然抬眼看向镜头。只做动作，不要说话。"),
        "right_down" => format!("头部与视线朝向右下角，向右下方斜向下{angle_deg}度查看，像在查看右下方手机上的新消息。动作自然流畅，保持放松，随后自然抬眼看向镜头。只做动作，不要说话。"),
        "left_up" => format!("头部与视线朝向左上角，向左上方斜向上{angle_deg}度查看。动作自然流畅，保持放松，随后自然回到平视前方、看向镜头的姿态。只做动作，不要说话。"),
        "right_up" => format!("头部与视线朝向右上角，向右上方斜向上{angle_deg}度查看。动作自然流畅，保持放松，随后自然回到平视前方、看向镜头的姿态。只做动作，不要说话。"),
        "left" => format!("头部与视线向左侧水平转动{angle_deg}度查看，保持平视，不抬头、不低头。动作自然流畅，保持放松，随后自然回到平视前方、看向镜头的姿态。只做动作，不要说话。"),
        "right" => format!("头部与视线向右侧水平转动{angle_deg}度查看，保持平视，不抬头、不低头。动作自然流畅，保持放松，随后自然回到平视前方、看向镜头的姿态。只做动作，不要说话。"),
        "up" => format!("头部与视线向正上方抬起，仰头{angle_deg}度查看，不向左右转头。动作自然流畅，保持放松，随后自然回到平视前方、看向镜头的姿态。只做动作，不要说话。"),
        "down" => format!("头部与视线向正下方低下，低头{angle_deg}度查看，不向左右转头。动作自然流畅，保持放松，随后自然回到平视前方、看向镜头的姿态。只做动作，不要说话。"),
        "front" => "头部保持端正，目光平视前方，自然看向镜头，肩颈放松，保持面对镜头的自然姿态。只做动作，不要说话。".to_string(),
        _ => return Err("未知的承接动作方向".into()),
    };
    Ok(json!({"text_action":{"msg_id":format!("handoff-{task_id}"),"content":content}}))
}

#[tauri::command]
async fn send_handoff_action(app: tauri::AppHandle, state: State<'_, AppState>, live_id: String, task_id: String, direction: String, angle_deg: Option<u16>) -> Result<(), String> {
    let payload = handoff_action_payload(&task_id, &direction, angle_deg.unwrap_or(30))?;
    let receipts = {
        let mut guard = state.session.lock().map_err(|e| e.to_string())?;
        let session = guard.as_mut().filter(|s| s.live_id == live_id).ok_or("原会话已结束，动作未发送")?;
        component_action::enqueue(session, payload)?
    };
    let result = component_action::wait(receipts).await;
    if let Err(error) = &result { let _ = app.emit("component-action-error", json!({"live_id":live_id,"task_id":task_id,"error":error})); }
    result
}

#[cfg(test)]
fn manual_question_signal(content: &str, message_type: Option<&str>) -> Result<(u64, Value), String> {
    let content = content.trim();
    if content.is_empty() { return Err("请输入问题".into()); }
    let msg_id = uuid::Uuid::new_v4().to_string();
    match message_type.unwrap_or("text_msg") {
        "text_msg" => Ok((99, json!({"text_msg":{"msg_id":msg_id,"content":content,"timestamp":unix_ms()}}))),
        "text_dialog" => Ok((102, json!({"text_dialog":{"msg_id":msg_id,"content":content}}))),
        _ => Err("手动提问仅支持 text_msg 或 text_dialog".into()),
    }
}

#[tauri::command]
async fn send_question(app: tauri::AppHandle, state: State<'_, AppState>, content: String, live_id: Option<String>, message_type: Option<String>) -> Result<(), String> {
    let _ = message_type;
    let live_id = {
        let guard = state.session.lock().map_err(|e| e.to_string())?;
        let session = guard.as_ref().ok_or("组件会话尚未启动")?;
        if live_id.as_ref().is_some_and(|id| id != &session.live_id) { return Err("原会话已结束".into()); }
        session.live_id.clone()
    };
    component::run(app, live_id, content, format!("manual-{}", uuid::Uuid::new_v4()), true).await
}

#[tauri::command]
fn interrupt_session(app: tauri::AppHandle, state: State<'_, AppState>, live_id: Option<String>) -> Result<(), String> {
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = guard.as_mut().ok_or("Vidu 会话尚未启动")?;
    if live_id.as_ref().is_some_and(|id| id != &session.live_id) { return Err("原会话已结束，已取消打断".into()); }
    session.speech_cancel.send_modify(|value| *value += 1);
    session.speaking = false;
    session.external_audio = None;
    send_signal(&app, session, 7, json!({}))
}

async fn reconnect_and_hangup(key: &str, region: &str, live_id: &str, conn_id: &str, seq: u64) -> Result<(), String> {
    let url = format!("{}/live/v1/external-lives/{}/stream?conn_id={}", ws_host(region), live_id, conn_id);
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
            session.speech_cancel.send_modify(|value| *value += 1);
            session.speaking = false;
            session.seq += 1;
            let message = json!({"type":5,"live_id":session.live_id,"conn_id":session.conn_id,"seq_id":session.seq,"payload":{"hangup":{"hangup_reason":"user_end"}}});
            (session.live_id.clone(), session.conn_id.clone(), session.key.clone(), session.region.clone(), session.seq, session.sender.clone(), Message::Text(message.to_string().into()))
        })
    };
    if let Some((live_id, conn_id, key, region, seq, sender, message)) = current {
        let (written, received) = oneshot::channel();
        let sent = sender.send(Outbound { message, written: Some(written), epoch: None }).is_ok()
            && matches!(tokio::time::timeout(std::time::Duration::from_secs(5), received).await, Ok(Ok(Ok(()))));
        let reconnect_error = if !sent { reconnect_and_hangup(&key, &region, &live_id, &conn_id, seq + 1).await.err() } else { None };
        let mut final_live = None;
        for _ in 0..10 {
            let result = live_status(key.clone(), region.clone(), live_id.clone()).await?;
            if result.pointer("/live/status").and_then(Value::as_str) == Some("ended") { final_live = result.get("live").cloned(); break; }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        let final_live = final_live.ok_or_else(|| format!("Vidu 尚未确认 ended，请重试结束会话{}", reconnect_error.map(|error| format!("：{error}")).unwrap_or_default()))?;
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
    let window = WebviewWindowBuilder::new(&app, "obs", WebviewUrl::App("index.html?view=obs".into()))
        .title("数字人画面 · OBS 窗口").inner_size(360.0, 640.0)
        .visible(false).resizable(false).maximizable(false)
        .build().map_err(|e| e.to_string())?;
    obs_window::resize_to_video(&window, 9, 16)?;
    window.center().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
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
    let mut body = json!({"voice":voice,"audio_url":audio_url,"language":"zh","provider":"qwen_omni"});
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

fn voice_document_url(provider: &str) -> Result<&'static str, String> {
    match provider {
        "ali" => Ok("https://platform.vidu.cn/vidu-stream/doc/voice-list?provider=ali"),
        "doubao3" => Ok("https://platform.vidu.cn/vidu-stream/doc/voice-list?provider=doubao3"),
        _ => Err("未知的官方音色列表".into()),
    }
}

#[tauri::command]
fn open_voice_document(provider: String) -> Result<(), String> {
    let url = voice_document_url(&provider)?;
    #[cfg(windows)] {
        use std::{ffi::c_void, ptr};
        #[link(name = "shell32")]
        unsafe extern "system" {
            fn ShellExecuteW(window: *mut c_void, operation: *const u16, file: *const u16, parameters: *const u16, directory: *const u16, show: i32) -> *mut c_void;
        }
        let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let file: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        let result = unsafe { ShellExecuteW(ptr::null_mut(), operation.as_ptr(), file.as_ptr(), ptr::null(), ptr::null(), 1) } as isize;
        if result <= 32 { return Err(format!("无法打开系统默认浏览器（错误码 {result}）")); }
        Ok(())
    }
    #[cfg(not(windows))] {
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        Command::new(opener).arg(url).spawn().map(|_| ()).map_err(|error| format!("无法打开系统默认浏览器：{error}"))
    }
}

fn main() {
    #[cfg(windows)]
    let Some(_instance_guard) = single_instance::Guard::acquire() else { return; };
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(prepared_speech::PreparedSpeech::default())
        .manage(queue_store::QueueStorage::default())
        .manage(songs::SongManager::default())
        .manage(whisper::WhisperRuntime::default())
        .manage(speech_runtime::LocalTtsRuntime::default())
        .manage(song_director::DirectorRuntime::default())
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
        .invoke_handler(tauri::generate_handler![prepared_speech::component_audio_open, prepared_speech::component_audio_retain, prepared_speech::component_prepare_audio, prepared_speech::component_play_prepared, component::component_prepare_reply, speech_runtime::component_local_status, speech_runtime::component_stop_local, component::component_tts_preview, speech_runtime::component_start_local, component::component_audio_begin, component::component_audio_push, component::component_transcription, component::component_local_voice, component::component_preflight, component::component_respond, component::component_configure, create_session, send_question, interrupt_session, tts_log::tts_log_load, tts_log::tts_log_song_observation, end_session, session_snapshot, playback_frame, live_status, open_obs_window, obs_window::fit_obs_video, open_voice_document, start_dyhub, stop_dyhub, dyhub_connect, dyhub_disconnect, clone_tts_voice, clone_live_voice, list_voices, account_credits, delete_voice, preview_voice, speak_text, send_avatar_action, send_handoff_action, model_api::list_models, model_api::generate_reply, model_api::generate_interaction, queue_store::queue_load, queue_store::queue_commit, queue_store::queue_archive_event, queue_store::queue_ack_event, queue_store::queue_save_config, speech_stt::speech_prepare, speech_stt::speech_transcribe, whisper::whisper_prepare, whisper::whisper_transcribe, songs::songs_create, songs::songs_list, songs::songs_delete, songs::songs_resume, songs::songs_attach_task, songs::songs_open_folder, song_director::director_list, song_director::director_get, song_director::director_create, song_director::director_transcribe, song_director::director_correct, song_director::director_save, song_director::director_delete, song_director::director_open_folder])
        .run(tauri::generate_context!())
        .expect("Tauri application failed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_questions_route_message_and_dialogue_to_their_own_protocol_types() {
        for (mode, expected_kind, field) in [(None, 99, "text_msg"), (Some("text_msg"), 99, "text_msg"), (Some("text_dialog"), 102, "text_dialog")] {
            let (kind, payload) = manual_question_signal("  你好，今天聊什么？  ", mode).unwrap();
            assert_eq!(kind, expected_kind);
            assert_eq!(payload[field]["content"], "你好，今天聊什么？");
            uuid::Uuid::parse_str(payload[field]["msg_id"].as_str().unwrap()).unwrap();
            assert_eq!(payload.as_object().unwrap().len(), 1);
            assert_eq!(payload[field].get("timestamp").is_some(), field == "text_msg");
        }
        assert!(manual_question_signal("  ", Some("text_dialog")).is_err());
        for mode in ["text_action", "text_tts", "102", ""] { assert!(manual_question_signal("你好", Some(mode)).is_err()); }
    }

    #[test]
    fn speech_uses_text_messages_with_task_ids_and_timestamps() {
        let before = unix_ms();
        let (kind, payload) = speech_message_signal("  第一行歌词\n第二行  ", Some("attempt-4".into())).unwrap();
        assert_eq!(kind, 99);
        assert_eq!(payload["text_msg"]["content"], "第一行歌词\n第二行");
        assert_eq!(payload["text_msg"]["msg_id"], "tts-attempt-4");
        let timestamp = payload["text_msg"]["timestamp"].as_u64().unwrap() as u128;
        assert!(timestamp >= before && timestamp <= unix_ms());
        assert!(payload.get("text_tts").is_none());
        for task_id in [None, Some("  ".into())] {
            let (kind, payload) = speech_message_signal("手动文字回复", task_id).unwrap();
            assert_eq!(kind, 99);
            assert_eq!(payload["text_msg"]["content"], "手动文字回复");
            uuid::Uuid::parse_str(payload["text_msg"]["msg_id"].as_str().unwrap()).unwrap();
        }
        assert!(speech_message_signal(" \n ", None).is_err());
    }

    #[test]
    fn transcription_frames_are_bound_to_the_socket_session() {
        let frame = r#"{"payload":{"text_msg":{"content":"你好，请问你可以帮我做什么？"}},"type":9}"#;
        let signal = session_signal(frame, "live-123").unwrap();
        assert_eq!(signal["live_id"], "live-123");
        assert_eq!(signal["type"], 9);
        assert!(signal["received_at"].as_u64().unwrap() > 0);
        let output = session_signal(r#"{"type":10,"received_at":1,"payload":{"text_msg":{"content":"实际回答"}}}"#, "live-123").unwrap();
        assert!(output["received_at"].as_u64().unwrap() > 1);
        assert_eq!(output["payload"]["text_msg"]["content"], "实际回答");
        assert_eq!(signal["payload"]["text_msg"]["content"], "你好，请问你可以帮我做什么？");
        assert_eq!(session_signal(r#"{"type":10,"live_id":"wrong"}"#, "live-123").unwrap()["live_id"], "live-123");
        assert!(session_signal("[]", "live-123").is_none());
        assert!(session_signal("invalid", "live-123").is_none());
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
    fn avatar_model_honors_selection_and_defaults_older_clients_to_s2() {
        assert_eq!(avatar_model(None).unwrap(), "vidu-s2");
        assert_eq!(avatar_model(Some("vidu-s1")).unwrap(), "vidu-s1");
        assert_eq!(avatar_model(Some("vidu-s2")).unwrap(), "vidu-s2");
        assert!(avatar_model(Some("")).is_err());
        assert!(avatar_model(Some("other-model")).is_err());
    }

    #[test]
    fn voice_document_links_only_open_the_two_official_catalogs() {
        assert_eq!(voice_document_url("ali").unwrap(), "https://platform.vidu.cn/vidu-stream/doc/voice-list?provider=ali");
        assert_eq!(voice_document_url("doubao3").unwrap(), "https://platform.vidu.cn/vidu-stream/doc/voice-list?provider=doubao3");
        assert!(voice_document_url("https://example.com").is_err());
    }

    #[test]
    fn chat_visual_actions_use_separate_signals_and_validate_descriptions() {
        let payload = avatar_action_payload("chat-1", None, Some("双手在脑后扎起马尾")).unwrap();
        assert_eq!(payload["text_action"]["msg_id"], "avatar-action-chat-1");
        let content = payload["text_action"]["content"].as_str().unwrap();
        assert!(content.contains("双手在脑后扎起马尾"));
        assert!(content.contains("只做动作，不要说话"));
        assert!(payload.get("text_tts").is_none());
        assert!(avatar_action_payload("", None, Some("挥手")).is_err());
        assert!(avatar_action_payload("chat-1", None, Some(" ")).is_err());
        assert!(avatar_action_payload("chat-1", None, Some("挥手\n说话")).is_err());
        assert!(avatar_action_payload("chat-1", None, Some(&"动".repeat(301))).is_err());
        assert_eq!(avatar_action_payload("gift-1", Some("heart"), None).unwrap(), gift_action_payload("gift-1", "heart").unwrap());
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

    #[test]
    fn handoff_actions_use_the_requested_direction_without_speech_or_arbitrary_commands() {
        for (direction, expected, angle_prefix) in [
            ("left_down", "左下", "斜向下"), ("right_down", "右下", "斜向下"),
            ("left_up", "左上", "斜向上"), ("right_up", "右上", "斜向上"),
            ("left", "左侧", "水平转动"), ("right", "右侧", "水平转动"),
            ("up", "正上方", "仰头"), ("down", "正下方", "低头"),
            ("front", "平视前方", ""),
        ] {
            for angle in [0, 30, 45, 90] {
                let payload = handoff_action_payload("task-1", direction, angle).unwrap();
                assert_eq!(payload["text_action"]["msg_id"], "handoff-task-1");
                let text = payload["text_action"]["content"].as_str().unwrap();
                assert!(text.contains(expected));
                if direction == "front" {
                    assert!(!text.contains("度"));
                    assert!(!text.contains("下角"));
                } else {
                    assert!(text.contains(&format!("{angle_prefix}{angle}度")));
                }
                assert!(text.contains("不要说话"));
                assert!(payload.get("text_tts").is_none());
            }
        }
        assert_eq!(handoff_action_payload("task-1", "front", 0).unwrap(), handoff_action_payload("task-1", "front", 90).unwrap());
        assert!(handoff_action_payload("task-1", "left_down", 91).is_err());
        assert!(handoff_action_payload("task-1", "arbitrary-command", 45).is_err());
        assert!(handoff_action_payload("", "left_down", 45).is_err());
    }
}
