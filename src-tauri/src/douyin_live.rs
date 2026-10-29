use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::{Emitter, Manager, State};
use tokio::sync::watch;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};

const VERSION: &str = "v2.3.2";
struct Service {
    child: Child,
    base: String,
    key: String,
}
struct Connection {
    id: String,
    cancel: watch::Sender<bool>,
}
#[derive(Default)]
struct Inner {
    service: Option<Service>,
    connection: Option<Connection>,
    owner: Option<String>,
    closed: bool,
}
#[derive(Default)]
pub struct DouyinRuntime {
    inner: Mutex<Inner>,
    operations: tokio::sync::Mutex<()>,
}
impl DouyinRuntime {
    pub fn shutdown(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.closed = true;
            inner.owner = None;
            if let Some(c) = inner.connection.take() {
                c.cancel.send_replace(true);
            }
            if let Some(mut s) = inner.service.take() {
                let _ = s.child.kill();
                let _ = s.child.wait();
            }
        }
    }
}
impl Drop for DouyinRuntime {
    fn drop(&mut self) {
        if let Ok(inner) = self.inner.get_mut() {
            if let Some(c) = inner.connection.take() {
                c.cancel.send_replace(true);
            }
            if let Some(mut s) = inner.service.take() {
                let _ = s.child.kill();
                let _ = s.child.wait();
            }
        }
    }
}

pub(crate) fn room_id(input: &str) -> Result<String, String> {
    let input = input.trim();
    let id = if input.contains("://") {
        let url = reqwest::Url::parse(input).map_err(|_| "直播间链接无效")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str() != Some("live.douyin.com")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return Err("请输入直播间号或 live.douyin.com 直播间链接".into());
        }
        url.path().trim_matches('/').to_owned()
    } else {
        input.to_owned()
    };
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err("直播间号无效，请复制直播间链接末尾的标识".into());
    }
    Ok(id)
}

fn share_url(input: &str) -> Result<Option<reqwest::Url>, String> {
    if !input.contains("://") {
        return Ok(None);
    }
    let mut url = reqwest::Url::parse(input.trim()).map_err(|_| "直播分享链接无效")?;
    if url.host_str() != Some("webcast.amemv.com") {
        return Ok(None);
    }
    let id = url
        .path()
        .strip_prefix("/douyin/webcast/reflow/")
        .unwrap_or("")
        .trim_end_matches('/');
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || id.is_empty()
        || id.len() > 30
        || !id.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("抖音直播分享链接无效".into());
    }
    // Device/share tracking parameters are unnecessary for the public live page.
    url.set_query(None);
    url.set_fragment(None);
    Ok(Some(url))
}
fn shared_web_rid(page: &str) -> Option<String> {
    let mut decoded = page.to_owned();
    for _ in 0..6 {
        let next = decoded.replace("\\\"", "\"");
        if next == decoded {
            break;
        }
        decoded = next;
    }
    for key in ["\"webRid\"", "\"web_rid\""] {
        for (i, _) in decoded.match_indices(key) {
            let Some(value) = decoded[i + key.len()..].trim_start().strip_prefix(':') else {
                continue;
            };
            let value = value.trim_start();
            let value = value.strip_prefix('"').unwrap_or(value);
            let id: String = value.chars().take_while(char::is_ascii_digit).collect();
            if !id.is_empty() && id.len() <= 128 {
                return Some(id);
            }
        }
    }
    None
}
async fn resolve_room(input: &str) -> Result<String, String> {
    let Some(url) = share_url(input)? else {
        return room_id(input);
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut response=client.get(url).header("User-Agent","Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36").send().await.map_err(|_|"读取抖音直播分享链接失败，请检查网络或改填网页直播间号")?;
    if !response.status().is_success() {
        return Err(format!(
            "读取抖音直播分享链接失败（HTTP {}），请改填网页直播间号",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取抖音分享页面失败")? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("抖音分享页面过大，请改填网页直播间号".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    shared_web_rid(&String::from_utf8_lossy(&bytes))
        .ok_or("分享页面未返回网页直播间号，请复制 live.douyin.com 的直播间链接".into())
}
fn value_string(v: &Value) -> String {
    v.as_str()
        .map(str::to_owned)
        .or_else(|| v.as_u64().map(|n| n.to_string()))
        .or_else(|| v.as_i64().map(|n| n.to_string()))
        .unwrap_or_default()
}
fn field<'a>(v: &'a Value, names: &[&str]) -> &'a Value {
    names
        .iter()
        .find_map(|name| v.get(*name))
        .unwrap_or(&Value::Null)
}
fn number(v: &Value) -> u64 {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}

// Keep the queue's durable event schema, with precise protobuf uint64 IDs.
pub(crate) fn normalize(v: &Value, room: &str, now: u128) -> Option<Value> {
    let kind = match v["method"].as_str()? {
        "WebcastChatMessage" => "chat",
        "WebcastGiftMessage" => "gift",
        "WebcastLikeMessage" => "like",
        "WebcastMemberMessage" => "member",
        "WebcastSocialMessage" => {
            if number(&v["action"]) == 1 {
                "follow"
            } else {
                "share"
            }
        }
        _ => return None,
    };
    let common = &v["common"];
    let user = v.get("user").unwrap_or(&common["user"]);
    let nickname = value_string(field(user, &["nickname", "nickName", "nick_name"]));
    let user_id = value_string(field(
        user,
        &["idStr", "id_str", "id", "userId", "user_id", "secUid"],
    ));
    let id = value_string(field(common, &["msgId", "msg_id"]));
    let mut ts = number(field(common, &["createTime", "create_time"]));
    if ts > 0 && ts < 1_000_000_000_000 {
        ts = ts.saturating_mul(1000);
    }
    if ts == 0 {
        ts = now as u64;
    }
    let mut event = json!({"id":if id.is_empty(){uuid::Uuid::new_v4().to_string()}else{id},"type":kind,"roomId":room,"ts":(ts as u128).min(now),"source":"douyinLive","user":{"id":user_id,"nickname":if nickname.is_empty(){"观众".into()}else{nickname}},"data":{}});
    if kind == "chat" {
        let content = v["content"].as_str()?.trim();
        if content.is_empty() {
            return None;
        }
        event["data"] = json!({"content":content});
    }
    if kind == "gift" {
        let gift = &v["gift"];
        let name = gift["name"].as_str().filter(|s| !s.trim().is_empty())?;
        let repeat = number(field(v, &["repeatCount", "repeat_count"]));
        let combo = number(field(v, &["comboCount", "combo_count"]));
        let count = repeat.max(combo).max(number(&v["count"])).max(1);
        let end = field(v, &["repeatEnd", "repeat_end"]);
        let combining = gift["combo"].as_bool() == Some(true) || !end.is_null() || repeat > 1;
        let gift_id = field(v, &["giftId", "gift_id"]);
        let gift_id = if gift_id.is_null() {
            &gift["id"]
        } else {
            gift_id
        };
        event["data"] = json!({"giftName":name,"giftId":value_string(gift_id),"groupId":value_string(field(v,&["groupId","group_id"])),"repeatCount":count,"comboCount":combo,"repeatEnd":number(end)==1||end.as_bool()==Some(true)||!combining});
    }
    Some(event)
}
fn executable(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resource = app.path().resource_dir().map_err(|e| e.to_string())?;
    [
        resource.join("douyin-live/douyinLive.exe"),
        resource.join("resources/douyin-live/douyinLive.exe"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/douyin-live/douyinLive.exe"),
    ]
    .into_iter()
    .find(|p| p.is_file())
    .ok_or("缺少douyinLive运行文件，请运行 npm run prepare:douyin".into())
}
async fn ensure_service(
    app: &tauri::AppHandle,
    runtime: &DouyinRuntime,
) -> Result<(String, String), String> {
    {
        let mut inner = runtime.inner.lock().map_err(|e| e.to_string())?;
        if inner.closed {
            return Err("弹幕采集窗口已关闭".into());
        }
        if let Some(service) = inner.service.as_mut() {
            if service
                .child
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_none()
            {
                return Ok((service.base.clone(), service.key.clone()));
            }
        }
        inner.service.take();
    }
    let exe = executable(app)?;
    let port = {
        let socket = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        socket.local_addr().map_err(|e| e.to_string())?.port()
    };
    let base = format!("http://127.0.0.1:{port}");
    let key = uuid::Uuid::new_v4().to_string();
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("douyin-live");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let config = dir.join("config.yaml");
    if !config.exists() {
        fs::write(&config,"protocol:\n  mode: web\nsign:\n  provider: local\ncookie:\n  use_stored: true\n  douyin: \"\"\n").map_err(|e|e.to_string())?;
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("service.log"))
        .map_err(|e| e.to_string())?;
    let mut command = Command::new(exe);
    command
        .current_dir(&dir)
        .arg("--config")
        .arg(config)
        .args([
            "--port",
            &port.to_string(),
            "--sign-provider",
            "local",
            "--log-level",
            "warn",
        ])
        .env("APP_API_KEY", &key)
        .env("APP_WEBSOCKET_PATH", "/ws")
        .env("APP_PROTOCOL", "web")
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动douyinLive失败：{e}"))?;
    {
        let mut inner = runtime.inner.lock().map_err(|e| e.to_string())?;
        if inner.closed {
            let _ = child.kill();
            let _ = child.wait();
            return Err("弹幕采集窗口已关闭".into());
        }
        inner.service = Some(Service {
            child,
            base: base.clone(),
            key: key.clone(),
        });
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1))
        .build()
        .map_err(|e| e.to_string())?;
    for _ in 0..30 {
        if let Ok(response) = client.get(format!("{base}/health")).send().await {
            if let Ok(health) = response.json::<Value>().await {
                if health["ok"] == true && health["data"]["tag"] == VERSION {
                    let auth = client
                        .get(format!("{base}/api/v1/capabilities"))
                        .bearer_auth(&key)
                        .send()
                        .await
                        .map_err(|_| "douyinLive健康检查失败")?;
                    if auth.status().is_success() {
                        return Ok((base, key));
                    }
                }
            }
        }
        if runtime
            .inner
            .lock()
            .map_err(|e| e.to_string())?
            .service
            .as_mut()
            .map(|s| s.child.try_wait())
            .transpose()
            .map_err(|e| e.to_string())?
            .flatten()
            .is_some()
        {
            return Err("douyinLive启动后退出，请检查本机douyin-live/service.log".into());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Err("douyinLive启动超时，请检查本机douyin-live/service.log".into())
}
fn current(app: &tauri::AppHandle, id: &str) -> bool {
    app.state::<DouyinRuntime>()
        .inner
        .lock()
        .ok()
        .is_some_and(|s| s.owner.as_deref() == Some(id))
}
fn status(
    app: &tauri::AppHandle,
    id: &str,
    room: &str,
    state: &str,
    message: &str,
    terminal: bool,
) {
    if current(app, id) {
        let _=app.emit("douyin-status",json!({"connection_id":id,"room_id":room,"status":state,"message":message,"terminal":terminal}));
    }
}
async fn consume<S>(
    mut socket: tokio_tungstenite::WebSocketStream<S>,
    mut cancel: watch::Receiver<bool>,
    mut received: impl FnMut(Value) -> bool,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.tick().await;
    loop {
        tokio::select! {biased;
            _=cancel.changed()=>{let _=socket.close(None).await;return Ok(());},
            next=socket.next()=>match next {
                Some(Ok(Message::Text(text)))=>{if text!="pong" {if let Ok(value)=serde_json::from_str::<Value>(&text){if !received(value){let _=socket.close(None).await;return Ok(());}}}},
                Some(Ok(Message::Ping(data)))=>socket.send(Message::Pong(data)).await.map_err(|_|"弹幕服务心跳失败")?,
                Some(Ok(Message::Close(_)))|None=>return Err("弹幕服务连接已断开，请重新连接直播间".into()),
                Some(Err(_))=>return Err("弹幕服务连接异常，请重新连接直播间".into()),_=>{},
            },
            _=heartbeat.tick()=>socket.send(Message::Text("ping".into())).await.map_err(|_|"弹幕服务心跳失败")?,
        }
    }
}
#[tauri::command]
pub async fn douyin_connect(
    app: tauri::AppHandle,
    runtime: State<'_, DouyinRuntime>,
    room_id: String,
    connection_id: String,
) -> Result<Value, String> {
    uuid::Uuid::parse_str(&connection_id).map_err(|_| "弹幕连接标识无效")?;
    let _operation = runtime.operations.lock().await;
    {
        let mut inner = runtime.inner.lock().map_err(|e| e.to_string())?;
        if inner.closed {
            return Err("弹幕采集窗口已关闭".into());
        }
        if let Some(old) = inner.connection.take() {
            old.cancel.send_replace(true);
        }
        inner.owner = Some(connection_id.clone());
    }
    status(
        &app,
        &connection_id,
        "",
        "connecting",
        "正在解析直播间地址…",
        false,
    );
    let room = resolve_room(&room_id).await?;
    if !current(&app, &connection_id) {
        return Err("直播间连接已取消".into());
    }
    status(
        &app,
        &connection_id,
        &room,
        "connecting",
        "正在启动douyinLive并连接直播间…",
        false,
    );
    let (base, key) = ensure_service(&app, &runtime).await?;
    let mut request = format!("{}/ws/{room}", base.replacen("http:", "ws:", 1))
        .into_client_request()
        .map_err(|_| "直播间连接地址无效")?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| "弹幕服务认证配置无效")?,
    );
    let (socket, _) = tokio::time::timeout(Duration::from_secs(10), connect_async(request))
        .await
        .map_err(|_| "连接douyinLive超时")?
        .map_err(|_| "无法连接douyinLive，请检查本机采集日志")?;
    let (cancel, cancelled) = watch::channel(false);
    runtime.inner.lock().map_err(|e| e.to_string())?.connection = Some(Connection {
        id: connection_id.clone(),
        cancel,
    });
    status(
        &app,
        &connection_id,
        &room,
        "connected",
        "已连接douyinLive，正在等待直播间状态与消息",
        false,
    );
    let result = json!({"room_id":room,"connection_id":connection_id});
    tauri::async_runtime::spawn(async move {
        let outcome = consume(socket, cancelled, |raw| {
            if !current(&app, &connection_id) {
                return false;
            }
            if raw["type"] == "system" {
                let terminal = matches!(
                    raw["code"].as_str(),
                    Some(
                        "ROOM_NOT_FOUND"
                            | "ROOM_CHECK_FAILED"
                            | "SERVICE_SHUTTING_DOWN"
                            | "CLIENT_TOO_SLOW"
                    )
                );
                status(
                    &app,
                    &connection_id,
                    &room,
                    raw["status"].as_str().unwrap_or("unknown"),
                    raw["message"].as_str().unwrap_or("正在等待直播间状态"),
                    terminal,
                );
                return !terminal;
            }
            if let Some(event) = normalize(&raw, &room, crate::unix_ms()) {
                let _ = app.emit(
                    "douyin-event",
                    json!({"connection_id":connection_id,"event":event}),
                );
            }
            true
        })
        .await;
        if let Err(error) = outcome {
            status(&app, &connection_id, &room, "disconnected", &error, true);
        }
    });
    Ok(result)
}
#[tauri::command]
pub async fn douyin_disconnect(
    runtime: State<'_, DouyinRuntime>,
    connection_id: String,
) -> Result<(), String> {
    let _operation = runtime.operations.lock().await;
    let mut inner = runtime.inner.lock().map_err(|e| e.to_string())?;
    if inner.owner.as_deref() != Some(&connection_id) {
        return Ok(());
    }
    inner.owner = None;
    if let Some(connection) = inner.connection.take() {
        if connection.id == connection_id {
            connection.cancel.send_replace(true);
        }
    }
    if let Some(mut service) = inner.service.take() {
        let _ = service.child.kill();
        let _ = service.child.wait();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn share_links_drop_tracking_and_use_web_rid_instead_of_long_room_id() {
        let url=share_url("https://webcast.amemv.com/douyin/webcast/reflow/7701736292790323994?did=private&sec_user_id=private#fragment").unwrap().unwrap();
        assert!(url.query().is_none());
        assert!(url.fragment().is_none());
        assert_eq!(shared_web_rid(r#"<script>{\"room\":{\"idStr\":\"7701736292790323994\",\"owner\":{\"webRid\":\"14214746370\"}}}</script>"#).as_deref(),Some("14214746370"));
        assert!(shared_web_rid(r#"{"webRid":""}"#).is_none());
        assert!(share_url("https://webcast.amemv.com/not-a-live-page").is_err());
        assert!(share_url("https://user@webcast.amemv.com/douyin/webcast/reflow/123").is_err());
        assert!(share_url("https://live.douyin.com/123").unwrap().is_none());
    }
    #[tokio::test]
    #[ignore = "reads local collector base/key and a user-provided room from stdin; receives public live chat without sending messages or starting Vidu"]
    async fn live_collector_websocket() {
        use std::io::Read;
        let mut input = String::new();
        std::io::stdin().read_to_string(&mut input).unwrap();
        let config: Value = serde_json::from_str(&input).unwrap();
        let room = resolve_room(config["room"].as_str().unwrap())
            .await
            .unwrap();
        let base = config["base"].as_str().unwrap();
        assert!(base.starts_with("http://127.0.0.1:"));
        let mut request = format!("{}/ws/{room}", base.replacen("http:", "ws:", 1))
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {}", config["key"].as_str().unwrap())).unwrap(),
        );
        let (socket, _) = connect_async(request).await.unwrap();
        let (_cancel, rx) = watch::channel(false);
        let mut counts = std::collections::BTreeMap::<String, u64>::new();
        let mut statuses = Vec::new();
        let mut chats = 0;
        let _ = tokio::time::timeout(
            Duration::from_secs(25),
            consume(socket, rx, |raw| {
                if raw["type"] == "system" {
                    statuses.push(raw["code"].as_str().unwrap_or("unknown").to_owned());
                } else if let Some(event) = normalize(&raw, &room, crate::unix_ms()) {
                    let kind = event["type"].as_str().unwrap().to_owned();
                    if kind == "chat" {
                        chats += 1;
                    }
                    *counts.entry(kind).or_default() += 1;
                }
                !(chats >= 3)
            }),
        )
        .await;
        println!(
            "collector_live_check={}",
            json!({"room":room,"statuses":statuses,"counts":counts})
        );
        assert!(chats > 0, "no actual chat received from provided live room");
    }
    #[test]
    fn room_accepts_web_rid_and_canonical_live_urls_only() {
        assert_eq!(room_id(" 12345 ").unwrap(), "12345");
        assert_eq!(
            room_id("https://live.douyin.com/abc_123/?enter_from=web_live").unwrap(),
            "abc_123"
        );
        for input in [
            "",
            "../bad",
            "https://evil.example/123",
            "https://live.douyin.com/123/more",
            "https://user@live.douyin.com/123",
            "123?room=bad",
        ] {
            assert!(room_id(input).is_err(), "{input}");
        }
    }
    #[test]
    fn chat_keeps_protobuf_uint64_precision_and_normalizes_seconds() {
        let event=normalize(&json!({"method":"WebcastChatMessage","common":{"msgId":"18446744073709551614","createTime":"1793200000"},"user":{"id":"9223372036854775806","nickname":"小宇"},"content":"  姐姐你好  "}),"123",1793200010000).unwrap();
        assert_eq!(event["id"], "18446744073709551614");
        assert_eq!(event["user"]["id"], "9223372036854775806");
        assert_eq!(event["ts"], 1793200000000u64);
        assert_eq!(event["data"]["content"], "姐姐你好");
        assert_eq!(event["roomId"], "123");
        assert_eq!(event["type"], "chat");
    }
    #[test]
    fn combo_gifts_preserve_group_and_final_update() {
        let mut raw = json!({"method":"WebcastGiftMessage","common":{"msgId":"101"},"user":{"id":"9","nickname":"阿豪"},"gift":{"id":"33","name":"玫瑰","combo":true},"groupId":"9223372036854775807","repeatCount":"5","comboCount":"4"});
        let running = normalize(&raw, "123", 1793200010000).unwrap();
        assert_eq!(running["data"]["repeatCount"], 5);
        assert_eq!(running["data"]["repeatEnd"], false);
        assert_eq!(running["data"]["giftId"], "33");
        assert_eq!(running["data"]["groupId"], "9223372036854775807");
        raw["repeatEnd"] = json!(1);
        let finished = normalize(&raw, "123", 1793200010000).unwrap();
        assert_eq!(finished["data"]["repeatEnd"], true);
    }
    #[test]
    fn noncombo_gifts_finish_and_malformed_messages_do_not_enter_queue() {
        let event = normalize(
            &json!({"method":"WebcastGiftMessage","gift":{"name":"跑车"},"count":"2"}),
            "123",
            1793200010000,
        )
        .unwrap();
        assert_eq!(event["data"]["repeatEnd"], true);
        assert_eq!(event["data"]["repeatCount"], 2);
        for raw in [
            json!({"type":"system","code":"ROOM_OFFLINE"}),
            json!({"method":"WebcastChatMessage","content":" "}),
            json!({"method":"WebcastGiftMessage","gift":{}}),
            json!({"method":"WebcastUnknown"}),
        ] {
            assert!(normalize(&raw, "123", 1793200010000).is_none());
        }
    }
    #[test]
    fn accepts_original_proto_field_names_without_losing_numeric_ids() {
        let event=normalize(&json!({"method":"WebcastChatMessage","common":{"msg_id":18446744073709551614u64,"create_time":"1793200000"},"user":{"id":9223372036854775806u64},"content":"你好"}),"123",1793200010000).unwrap();
        assert_eq!(event["id"], "18446744073709551614");
        assert_eq!(event["user"]["id"], "9223372036854775806");
    }
    #[tokio::test]
    async fn websocket_reads_real_text_frames_and_cancellation_closes_transport() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            for value in [
                json!({"type":"system","code":"ROOM_OFFLINE","status":"offline"}),
                json!({"method":"WebcastChatMessage","content":"你好","common":{"msgId":"5"}}),
            ] {
                ws.send(Message::Text(value.to_string())).await.unwrap();
            }
            ws.send(Message::Text("pong".into())).await.unwrap();
            assert!(matches!(ws.next().await, Some(Ok(Message::Close(_)))));
        });
        let (ws, _) = connect_async(format!("ws://{addr}/ws/123")).await.unwrap();
        let (cancel, rx) = watch::channel(false);
        let mut received = Vec::new();
        tokio::time::timeout(
            Duration::from_secs(3),
            consume(ws, rx, |v| {
                received.push(v);
                if received.len() == 2 {
                    cancel.send_replace(true);
                }
                true
            }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(received.len(), 2);
        assert_eq!(received[0]["status"], "offline");
        assert_eq!(
            normalize(&received[1], "123", 1793200010000).unwrap()["type"],
            "chat"
        );
        server.await.unwrap();
    }
}
