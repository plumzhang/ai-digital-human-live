#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, process::{Child, Command, Stdio}, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::{connect_async, tungstenite::{client::IntoClientRequest, http::HeaderValue, Message}};

#[derive(Default)]
struct AppState {
    dyhub: Mutex<Option<Child>>,
    session: Mutex<Option<Session>>,
}

struct Session {
    live_id: String,
    conn_id: String,
    rtc: Value,
    sender: UnboundedSender<Message>,
    seq: u64,
}

#[derive(Serialize, Clone)]
struct SessionSnapshot { live_id: String, rtc: Value }

#[derive(Deserialize)]
struct AvatarSettings {
    image_uri: String,
    persona: String,
    voice: String,
    greeting_instruction: String,
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

#[tauri::command]
async fn create_session(app: tauri::AppHandle, state: State<'_, AppState>, key: String, region: String, avatar: AvatarSettings) -> Result<SessionSnapshot, String> {
    if state.session.lock().map_err(|e| e.to_string())?.is_some() { return Err("已有运行中的 Vidu 会话，请先结束".into()); }
    let key = normalized_key(&key)?;
    if avatar.image_uri.trim().is_empty() || avatar.persona.trim().is_empty() { return Err("请填写形象图片和人设".into()); }
    let client = reqwest::Client::new();
    let persona = if avatar.greeting_instruction.trim().is_empty() { avatar.persona.clone() } else { format!("{}\n开场时：{}", avatar.persona, avatar.greeting_instruction) };
    let body = json!({
        "call_mode": "video",
        "character_id": "1",
        "avatar": {
            "image_uri": avatar.image_uri,
            "persona": persona,
            "voice": avatar.voice,
            "persona_enhance": false
        },
    });
    let response = client.post(format!("{}/live/s_avatar/realtime", api_host(&region)))
        .header("Authorization", format!("Token {}", key)).json(&body).send().await.map_err(|e| e.to_string())?;
    let data = response_json(response).await?;
    let live_id = data.pointer("/live/id").and_then(Value::as_str).ok_or("Vidu 响应缺少 live.id")?.to_string();
    let rtc = data.get("rtc").cloned().ok_or("Vidu 响应缺少 RTC 凭证")?;
    let conn_id = format!("desktop-{}", uuid::Uuid::new_v4());
    let url = format!("{}/live/ws/live/connect?live_id={}&conn_id={}", ws_host(&region), live_id, conn_id);
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert("Authorization", HeaderValue::from_str(&format!("Token {}", key)).map_err(|e| e.to_string())?);
    let (ws, _) = connect_async(request).await.map_err(|e| format!("Vidu WebSocket 连接失败: {e}"))?;
    let (mut writer, mut reader) = ws.split();
    let (sender, mut receiver) = unbounded_channel::<Message>();
    let init = json!({"type":1,"live_id":live_id,"conn_id":conn_id,"seq_id":1,"payload":{"conn_init":{"version":1}}});
    writer.send(Message::Text(init.to_string().into())).await.map_err(|e| e.to_string())?;
    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut retries = 0_u64;
        loop {
            tokio::select! {
                outgoing = receiver.recv() => {
                    match outgoing {
                        Some(message) => if writer.send(message).await.is_err() { break; },
                        None => break,
                    }
                }
                incoming = reader.next() => {
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                                if value.get("type").and_then(Value::as_u64) == Some(2)
                                    && value.pointer("/payload/conn_init_ack/error_code").and_then(Value::as_str) == Some("NOT_READY")
                                    && retries < 20 {
                                    retries += 1;
                                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                                    let retry = json!({"type":1,"live_id":value.get("live_id"),"conn_id":value.get("conn_id"),"seq_id":retries+1,"payload":{"conn_init":{"version":1}}});
                                    if writer.send(Message::Text(retry.to_string().into())).await.is_err() { break; }
                                }
                                let _ = app_for_task.emit("vidu-signal", value);
                            }
                        }
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        _ => {}
                    }
                }
            }
        }
        let _ = app_for_task.emit("vidu-disconnected", ());
    });
    let snapshot = SessionSnapshot { live_id: live_id.clone(), rtc: rtc.clone() };
    *state.session.lock().map_err(|e| e.to_string())? = Some(Session { live_id, conn_id, rtc, sender, seq: 100 });
    let _ = app.emit("session-changed", snapshot.clone());
    Ok(snapshot)
}

fn send_signal(session: &mut Session, kind: u64, payload: Value) -> Result<(), String> {
    session.seq += 1;
    let message = json!({"type":kind,"live_id":session.live_id,"conn_id":session.conn_id,"seq_id":session.seq,"payload":payload});
    session.sender.send(Message::Text(message.to_string().into())).map_err(|e| e.to_string())
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

#[tauri::command]
fn end_session(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(mut session) = state.session.lock().map_err(|e| e.to_string())?.take() {
        let _ = send_signal(&mut session, 5, json!({"hangup":{"hangup_reason":"user_end"}}));
    }
    let _ = app.emit("session-ended", ());
    Ok(())
}

#[tauri::command]
fn session_snapshot(state: State<'_, AppState>) -> Result<Option<SessionSnapshot>, String> {
    Ok(state.session.lock().map_err(|e| e.to_string())?.as_ref().map(|s| SessionSnapshot { live_id: s.live_id.clone(), rtc: s.rtc.clone() }))
}

#[tauri::command]
fn open_obs_window(app: tauri::AppHandle) -> Result<(), String> {
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
async fn clone_voice(key: String, region: String, voice: String, audio_url: String, transcript: String) -> Result<Value, String> {
    let key = normalized_key(&key)?;
    if voice.trim().is_empty() || audio_url.trim().is_empty() { return Err("请填写音色名称并选择音频或填写公网 URL".into()); }
    let response = reqwest::Client::new().post(format!("{}/live/v1/voices/clone", api_host(&region)))
        .header("Authorization", format!("Token {}", key))
        .json(&json!({"voice":voice,"audio_url":audio_url,"text":transcript,"language":"zh"}))
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

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![create_session, send_question, interrupt_session, end_session, session_snapshot, open_obs_window, start_dyhub, stop_dyhub, dyhub_connect, dyhub_disconnect, clone_voice, list_voices])
        .run(tauri::generate_context!())
        .expect("Tauri application failed");
}
