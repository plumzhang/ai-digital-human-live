use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::{HashMap, HashSet}, fs::{self, File}, io::Write, path::{Path, PathBuf}, sync::Mutex, time::{Duration, Instant}};
use tauri::{Manager, State};

#[derive(Default)]
pub struct SongManager {
    storage: Mutex<()>,
    running: Mutex<HashSet<String>>,
    keys: Mutex<HashMap<String, String>>,
}

#[derive(Deserialize, Serialize)]
pub struct SongRequest {
    pub title: String,
    #[serde(default)]
    pub avatar_id: Option<String>,
    #[serde(default)]
    pub avatar_name: Option<String>,
    pub premium_mv_mode: String,
    pub lip_ref_urls: Option<String>,
    pub images: Option<String>,
    pub audio_url: String,
    pub audio_duration: f64,
    pub prompt: String,
    pub aspect_ratio: String,
    pub resolution: String,
    pub add_subtitle: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Song {
    id: String,
    task_id: Option<String>,
    title: String,
    #[serde(default)]
    avatar_id: Option<String>,
    #[serde(default)]
    avatar_name: Option<String>,
    mode: String,
    region: String,
    resolution: String,
    aspect_ratio: String,
    created_at: u128,
    status: String,
    progress: Option<f64>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    local_path: Option<String>,
    error: Option<String>,
    #[serde(default)]
    available: bool,
}

fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("songs"))
}

fn database(directory: &Path) -> Result<Connection, String> {
    fs::create_dir_all(directory.join("videos")).map_err(|e| e.to_string())?;
    let db = Connection::open(directory.join("songs.db")).map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS deleted_songs (id TEXT PRIMARY KEY);")
        .map_err(|e| e.to_string())?;
    Ok(db)
}

fn save_to(db: &Connection, song: &Song) -> Result<(), String> {
    let mut song = song.clone();
    song.error = song.error.as_deref().map(|error| safe_error(error, ""));
    let changed = db.execute("INSERT INTO songs(id,body) SELECT ?1,?2 WHERE NOT EXISTS (SELECT 1 FROM deleted_songs WHERE id=?1) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
        params![song.id, serde_json::to_string(&song).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
    if changed == 0 { return Err("歌曲记录已删除，已停止本机处理".into()); }
    Ok(())
}

fn save(app: &tauri::AppHandle, song: &Song) -> Result<(), String> {
    let manager = app.state::<SongManager>();
    let _guard = manager.storage.lock().map_err(|e| e.to_string())?;
    save_to(&database(&directory(app)?)?, song)
}

fn load_all(app: &tauri::AppHandle) -> Result<Vec<Song>, String> {
    let manager = app.state::<SongManager>();
    let _guard = manager.storage.lock().map_err(|e| e.to_string())?;
    let db = database(&directory(app)?)?;
    let bodies = {
        let mut statement = db.prepare("SELECT body FROM songs ORDER BY rowid DESC").map_err(|e| e.to_string())?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    bodies.into_iter().map(|body| {
        let mut song: Song = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        if repair_saved_error(&mut song) { save_to(&db, &song)?; }
        song.available = song.local_path.as_ref().is_some_and(|path| Path::new(path).is_file());
        Ok(song)
    }).collect()
}

fn validate_media(value: &str, kind: &str, limit: usize) -> Result<(), String> {
    // Uploads use data URIs, avoiding a separate public file hosting service.
    let (header, content) = value.split_once(",").ok_or("上传文件编码无效")?;
    let allowed = if kind == "audio" {
        ["audio/mpeg", "audio/wav", "audio/aac", "audio/mp4"].as_slice()
    } else {
        ["image/jpeg", "image/png", "image/webp", "image/bmp"].as_slice()
    };
    let mime = header.strip_prefix("data:").and_then(|s| s.strip_suffix(";base64")).ok_or("上传文件编码无效")?;
    if !allowed.contains(&mime) || (kind == "scene" && mime == "image/bmp") {
        return Err("上传文件格式不受支持".into());
    }
    let padding = content.bytes().rev().take_while(|b| *b == b'=').count();
    if content.is_empty() || content.len() % 4 != 0 || padding > 2 || !content[..content.len() - padding].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/') {
        return Err("上传文件 Base64 编码无效".into());
    }
    if content.len() / 4 * 3 - padding >= limit { return Err("上传文件过大，请压缩后再试".into()); }
    Ok(())
}

fn validate_portrait(value: &str) -> Result<(), String> {
    if value.starts_with("data:") { return validate_media(value, "image", 10 * 1024 * 1024); }
    let url = reqwest::Url::parse(value).map_err(|_| "数字人的形象图片地址无效")?;
    if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("数字人的形象图片需使用可公开访问的 HTTP(S) 地址".into());
    }
    Ok(())
}

fn payload(request: &SongRequest) -> Result<Value, String> {
    match (&request.avatar_id, &request.avatar_name) {
        (None, None) => (), // Older saved clients and tasks have no avatar binding.
        (Some(id), Some(name)) if !id.trim().is_empty() && id.len() <= 200 && !name.trim().is_empty() && name.chars().count() <= 50 => (),
        _ => return Err("歌曲绑定的数字人信息无效，请重新选择数字人".into()),
    }
    let singing = matches!(request.premium_mv_mode.as_str(), "sing" | "sing_perform");
    if !singing && !matches!(request.premium_mv_mode.as_str(), "perform" | "dance") { return Err("请选择有效的生成模式".into()); }
    if request.title.trim().is_empty() || request.title.chars().count() > 100 { return Err("歌曲名称需要 1～100 个字符".into()); }
    if !request.audio_duration.is_finite() || !(10.0..=300.0).contains(&request.audio_duration) { return Err("歌声音频时长需为 10～300 秒".into()); }
    if !["720p", "1080p"].contains(&request.resolution.as_str()) || !["1:1", "16:9", "9:16", "4:3", "3:4"].contains(&request.aspect_ratio.as_str()) { return Err("视频清晰度或比例无效".into()); }
    if request.prompt.chars().count() > 3000 { return Err("画面描述不能超过 3000 字".into()); }
    validate_media(&request.audio_url, "audio", 20 * 1024 * 1024)?;
    let mut body = serde_json::json!({
        "premium_mv_mode": request.premium_mv_mode, "audio_url": request.audio_url,
        "prompt": request.prompt, "aspect_ratio": request.aspect_ratio,
        "resolution": request.resolution, "add_subtitle": request.add_subtitle,
    });
    // Both fields are repeated images in Vidu's protobuf JSON request.
    // Even a single URL or data URI must be wrapped in a JSON array.
    if singing {
        let image = request.lip_ref_urls.as_deref().filter(|s| !s.is_empty()).ok_or("唱歌模式请上传正面近景照片")?;
        validate_portrait(image)?;
        body["lip_ref_urls"] = serde_json::json!([image]);
    }
    if let Some(image) = request.images.as_deref().filter(|s| !s.is_empty()) {
        validate_media(image, "scene", 10 * 1024 * 1024)?;
        body["images"] = serde_json::json!([image]);
    } else if !singing { return Err("表演和跳舞模式请上传场景参考图片".into()); }
    Ok(body)
}

fn client(timeout: u64) -> Result<Client, String> {
    Client::builder().connect_timeout(Duration::from_secs(20)).timeout(Duration::from_secs(timeout)).build().map_err(|e| e.to_string())
}

fn redact(error: String, key: &str) -> String {
    safe_error(&error, key)
}

fn safe_error(error: &str, key: &str) -> String {
    let mut text = if key.is_empty() { error.to_string() } else { error.replace(key, "***") };
    // Codec errors may echo the entire uploaded file. Remove it before truncating,
    // so the useful error prefix/suffix survive without storing image/audio data.
    while let Some(start) = text.find("data:") {
        let end = text[start..].char_indices().find(|(_, c)| c.is_whitespace() || matches!(c, '"' | '\'' | '\\' | ']'))
            .map(|(offset, _)| start + offset).unwrap_or(text.len());
        text.replace_range(start..end, "[上传内容已省略]");
    }
    while let Some(start) = text.find("vda_") {
        let end = text[start..].bytes().position(|b| !b.is_ascii_alphanumeric() && b != b'_' && b != b'-').map(|offset| start + offset).unwrap_or(text.len());
        text.replace_range(start..end, "[Key已省略]");
    }
    if text.chars().count() > 800 { format!("{}…", text.chars().take(800).collect::<String>()) } else { text }
}

fn insufficient_credit_message(region: &str) -> String {
    let region = if region == "global" { "国际区" } else { "中国区" };
    format!("Vidu {region} API 账户积分不足（CreditInsufficient），无法生成歌曲视频。请到 Vidu 开放平台检查当前 API Key 所属账户的可用积分，补足后重新生成。")
}

fn repair_saved_error(song: &mut Song) -> bool {
    let before = (song.status.clone(), song.error.clone());
    if let Some(error) = song.error.as_deref() {
        if song.task_id.is_none() && song.status == "submission_unknown" && error.contains("HTTP 400") && error.contains("body unmarshal proto") {
            song.status = "submission_failed".into();
            song.error = Some("提交失败：接口拒绝了参数格式不正确的请求。请在修复后的应用中重新生成歌曲视频。".into());
        } else if matches!(song.status.as_str(), "failed" | "submission_failed") && error.contains("CreditInsufficient") {
            song.error = Some(insufficient_credit_message(&song.region));
        } else { song.error = Some(safe_error(error, "")); }
    }
    before != (song.status.clone(), song.error.clone())
}

#[derive(Debug)]
enum SubmitError { Rejected(String), Uncertain(String) }

async fn create_task(client: &Client, endpoint: &str, key: &str, body: &Value) -> Result<String, SubmitError> {
    // Do not retry POST: an interrupted response can still represent a created task.
    let response = client.post(endpoint).header("Authorization", format!("Token {key}")).json(body).send().await
        .map_err(|e| SubmitError::Uncertain(safe_error(&e.to_string(), key)))?;
    let status = response.status();
    let value = response.json::<Value>().await;
    if !status.is_success() {
        let detail = value.as_ref().ok().and_then(|v| v.get("message").and_then(Value::as_str)
            .or_else(|| v.pointer("/error/message").and_then(Value::as_str))
            .or_else(|| v.get("err_code").and_then(Value::as_str))).unwrap_or("接口返回错误");
        let insufficient = value.as_ref().ok().is_some_and(|v| ["/err_code", "/code", "/reason", "/error/code"].iter()
            .any(|field| v.pointer(field).and_then(Value::as_str) == Some("CreditInsufficient")));
        let reason = format!("Vidu HTTP {status}：{}", if insufficient { "CreditInsufficient".into() } else { safe_error(detail, key) });
        return Err(if status.is_client_error() && ![408, 409].contains(&status.as_u16()) { SubmitError::Rejected(reason) } else { SubmitError::Uncertain(reason) });
    }
    let value = value.map_err(|_| SubmitError::Uncertain("接口响应不是有效的 JSON".into()))?;
    value.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_string)
        .ok_or_else(|| SubmitError::Uncertain("接口响应缺少任务 ID".into()))
}

fn submission_error(song: &mut Song, error: SubmitError) -> String {
    let message = match error {
        SubmitError::Rejected(reason) => {
            song.status = "submission_failed".into();
            if reason.contains("CreditInsufficient") { insufficient_credit_message(&song.region) }
            else { format!("提交失败：{reason}。请修正后重新提交。") }
        }
        SubmitError::Uncertain(reason) => { song.status = "submission_unknown".into(); format!("提交未确认：{reason}。请先到 Vidu 控制台核对任务，避免重复提交计费；可用任务 ID 恢复查询。") }
    };
    song.error = Some(message.clone());
    message
}

#[tauri::command]
pub async fn songs_create(app: tauri::AppHandle, key: String, region: String, request: SongRequest) -> Result<Song, String> {
    if !["cn", "global"].contains(&region.as_str()) { return Err("API 地区无效".into()); }
    let key = crate::normalized_key(&key)?;
    let body = payload(&request)?;
    let client = client(180)?;
    let mut song = Song {
        id: uuid::Uuid::new_v4().to_string(), task_id: None, title: request.title.trim().into(), mode: request.premium_mv_mode,
        avatar_id: request.avatar_id, avatar_name: request.avatar_name.map(|name| name.trim().to_string()),
        region, resolution: request.resolution, aspect_ratio: request.aspect_ratio, created_at: crate::unix_ms(),
        status: "submitting".into(), progress: None, downloaded_bytes: 0, total_bytes: None, local_path: None, error: None, available: false,
    };
    save(&app, &song)?;
    let result = create_task(&client, &format!("{}/ent/v2/one-click/premium_mv", crate::api_host(&song.region)), &key, &body).await;
    match result {
        Ok(id) => {
            song.task_id = Some(id);
            song.status = "created".into();
        }
        Err(error) => {
            let message = submission_error(&mut song, error);
            save(&app, &song)?;
            return Err(message);
        }
    }
    // Persist the task ID before starting polling, and never persist the API key or uploads.
    save(&app, &song).map_err(|e| format!("Vidu 已创建任务 {}，但本机保存失败：{e}。请保留此 ID 恢复查询，勿重复生成。", song.task_id.as_deref().unwrap_or_default()))?;
    app.state::<SongManager>().keys.lock().map_err(|e| e.to_string())?.insert(song.region.clone(), key);
    start_worker(app, song.clone())?;
    Ok(song)
}

#[tauri::command]
pub async fn songs_list(app: tauri::AppHandle) -> Result<Value, String> {
    Ok(serde_json::json!({"songs": load_all(&app)?, "directory": directory(&app)?.join("videos").to_string_lossy()}))
}

fn deletable(status: &str) -> bool {
    matches!(status, "success" | "failed" | "submission_failed" | "download_failed")
}

fn delete_from(db: &mut Connection, directory: &Path, id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(id).map_err(|_| "歌曲记录 ID 无效")?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let body: Option<String> = tx.query_row("SELECT body FROM songs WHERE id=?1", params![id], |row| row.get(0))
        .optional().map_err(|e| e.to_string())?;
    let Some(body) = body else { return Ok(()); };
    let song: Song = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if !deletable(&song.status) { return Err("进行中或提交结果待确认的任务不能删除，请等待任务结束".into()); }
    let root = directory.join("videos").canonicalize().map_err(|e| e.to_string())?;
    let paths = [root.join(format!("{id}.mp4")), root.join(format!("{id}.mp4.part"))];
    // Use only app-owned filenames; never delete an arbitrary path from a saved record.
    for path in &paths {
        match path.canonicalize() {
            Ok(resolved) if resolved.parent() != Some(root.as_path()) || !resolved.is_file() => return Err("视频文件路径不属于歌曲保存目录中的文件，无法删除".into()),
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(format!("无法检查视频文件：{error}")),
            _ => {},
        }
    }
    for path in &paths {
        if let Err(error) = fs::remove_file(path) {
            if error.kind() != std::io::ErrorKind::NotFound { return Err(format!("无法删除本地视频，请关闭占用文件的播放器后重试：{error}")); }
        }
    }
    // Prevent delayed resume/list snapshots from restoring a deleted record.
    tx.execute("INSERT OR IGNORE INTO deleted_songs(id) VALUES(?1)", params![id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM songs WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn songs_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let manager = app.state::<SongManager>();
    let _guard = manager.storage.lock().map_err(|e| e.to_string())?;
    if manager.running.lock().map_err(|e| e.to_string())?.contains(&id) {
        return Err("此任务正在处理，暂时不能删除，请等待任务结束".into());
    }
    delete_from(&mut database(&directory(&app)?)?, &directory(&app)?, &id)
}

fn resumable(status: &str) -> bool { matches!(status, "created" | "queueing" | "processing" | "downloading" | "download_failed") }

#[tauri::command]
pub async fn songs_resume(app: tauri::AppHandle, key: String, region: String, id: Option<String>) -> Result<(), String> {
    let key = crate::normalized_key(&key)?;
    app.state::<SongManager>().keys.lock().map_err(|e| e.to_string())?.insert(region.clone(), key);
    for mut song in load_all(&app)? {
        let missing_download = id.is_some() && song.status == "success" && !song.available;
        if song.region == region && song.task_id.is_some() && (resumable(&song.status) || missing_download) && id.as_ref().is_none_or(|id| id == &song.id) {
            if missing_download { song.status = "downloading".into(); song.local_path = None; save(&app, &song)?; }
            start_worker(app.clone(), song)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn songs_attach_task(app: tauri::AppHandle, key: String, region: String, id: String, task_id: String) -> Result<(), String> {
    let key = crate::normalized_key(&key)?;
    let task_id = task_id.trim();
    if task_id.is_empty() || task_id.len() > 200 || !task_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') { return Err("任务 ID 格式无效".into()); }
    let mut song = load_all(&app)?.into_iter().find(|s| s.id == id && s.region == region).ok_or("未找到该地区的歌曲任务")?;
    if !matches!(song.status.as_str(), "submitting" | "submission_unknown") { return Err("此任务已有任务 ID，无需恢复".into()); }
    song.task_id = Some(task_id.into()); song.status = "created".into(); song.error = None;
    save(&app, &song)?;
    app.state::<SongManager>().keys.lock().map_err(|e| e.to_string())?.insert(region, key);
    start_worker(app, song)
}

struct RunningGuard { app: tauri::AppHandle, id: String }
impl Drop for RunningGuard {
    fn drop(&mut self) { if let Ok(mut running) = self.app.state::<SongManager>().running.lock() { running.remove(&self.id); } }
}

fn start_worker(app: tauri::AppHandle, song: Song) -> Result<(), String> {
    let manager = app.state::<SongManager>();
    let _storage = manager.storage.lock().map_err(|e| e.to_string())?;
    let db = database(&directory(&app)?)?;
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM songs WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM deleted_songs WHERE id=?1))", params![song.id], |row| row.get(0)).map_err(|e| e.to_string())?;
    if !exists { return Ok(()); }
    let mut running = manager.running.lock().map_err(|e| e.to_string())?;
    if !running.insert(song.id.clone()) { return Ok(()); }
    let guard = RunningGuard { app: app.clone(), id: song.id.clone() };
    let worker_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let app = worker_app;
        let _guard = guard;
        let mut song = song;
        if let Err(error) = track(&app, &mut song).await {
            song.error = Some(error);
            if song.status == "downloading" { song.status = "download_failed".into(); }
            let _ = save(&app, &song);
        }
    });
    Ok(())
}

fn apply_status(song: &mut Song, value: &Value) -> Result<(), String> {
    let status = value["state"].as_str().or_else(|| value["status"].as_str()).ok_or("查询响应缺少任务状态，将继续查询")?;
    if !matches!(status, "created" | "queueing" | "processing" | "success" | "failed") { return Err(format!("暂未识别任务状态 {status}，将继续查询")); }
    song.status = if status == "success" { "downloading" } else { status }.into();
    song.progress = value["progress"].as_f64().filter(|n| n.is_finite() && (0.0..=100.0).contains(n));
    song.error = if status == "failed" {
        let code = value["err_code"].as_str().filter(|s| !s.is_empty()).unwrap_or("服务端未提供原因");
        Some(if code == "CreditInsufficient" { insufficient_credit_message(&song.region) } else { format!("生成失败：{code}") })
    } else { None };
    Ok(())
}

async fn track(app: &tauri::AppHandle, song: &mut Song) -> Result<(), String> {
    let client = client(60)?;
    let mut failures = 0u32;
    loop {
        let key = app.state::<SongManager>().keys.lock().map_err(|e| e.to_string())?.get(&song.region).cloned().ok_or("请填写 API Key 以继续查询")?;
        let result = async {
            let mut url = reqwest::Url::parse(crate::api_host(&song.region)).map_err(|e| e.to_string())?;
            url.path_segments_mut().map_err(|_| "API 地址无效")?.extend(["ent", "v2", "tasks", song.task_id.as_deref().ok_or("缺少任务 ID")?, "creations"]);
            let response = client.get(url).header("Authorization", format!("Token {key}")).send().await.map_err(|e| e.to_string())?;
            let value = crate::response_json(response).await?;
            apply_status(song, &value)?;
            Ok::<Value, String>(value)
        }.await;
        match result {
            Ok(value) => {
                failures = 0;
                save(app, song)?;
                if song.status == "failed" { return Ok(()); }
                if song.status == "downloading" {
                    let url = value.pointer("/creations/0/url").and_then(Value::as_str).filter(|s| !s.is_empty())
                        .or_else(|| value.pointer("/creations/0/watermarked_url").and_then(Value::as_str).filter(|s| !s.is_empty()));
                    if let Some(url) = url {
                        download(app, song, url).await?;
                        song.status = "success".into(); song.error = None; song.available = true;
                        save(app, song)?;
                        return Ok(());
                    }
                    song.error = Some("生成已完成，正在等待服务端返回视频地址".into());
                    save(app, song)?;
                }
            }
            Err(error) => {
                failures = failures.saturating_add(1);
                song.error = Some(format!("查询暂未成功，将自动重试：{}", redact(error, &key)));
                save(app, song)?;
            }
        }
        tokio::time::sleep(Duration::from_secs(if failures == 0 { 10 } else { (10 * u64::from(failures)).min(60) })).await;
    }
}

async fn download(app: &tauri::AppHandle, song: &mut Song, url: &str) -> Result<(), String> {
    let target = directory(app)?.join("videos").join(format!("{}.mp4", song.id));
    download_to(song, url, &target, |song| save(app, song)).await
}

async fn download_to(song: &mut Song, url: &str, target: &Path, mut persist: impl FnMut(&Song) -> Result<(), String>) -> Result<(), String> {
    // A crash can occur after the atomic rename but before the final database write.
    // Recover the completed file instead of redownloading or overwriting it.
    if let Ok(metadata) = fs::metadata(target) {
        if metadata.is_file() && metadata.len() > 0 {
            song.local_path = Some(target.to_string_lossy().into());
            song.downloaded_bytes = metadata.len(); song.total_bytes = Some(metadata.len());
            return Ok(());
        }
    }
    let url = reqwest::Url::parse(url).map_err(|_| "生成的视频地址无效")?;
    if !["http", "https"].contains(&url.scheme()) { return Err("生成的视频地址必须为 HTTP(S)".into()); }
    let temporary = target.with_extension("mp4.part");
    // Downloads have no Authorization header: signed media URLs are on a separate host.
    let mut response = client(1800)?.get(url).send().await.map_err(|_| "视频下载连接失败，请重试下载")?
        .error_for_status().map_err(|e| format!("视频下载失败（HTTP {}），请重试以刷新下载地址", e.status().map(|s| s.as_u16()).unwrap_or(0)))?;
    if response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|t| t.contains("text/html") || t.contains("application/json")) {
        return Err("下载地址返回了错误页面，请重试下载".into());
    }
    song.downloaded_bytes = 0; song.total_bytes = response.content_length(); song.progress = None; song.error = None;
    persist(song)?;
    let mut file = File::create(&temporary).map_err(|e| format!("无法保存视频：{e}"))?;
    let mut last_update = Instant::now();
    while let Some(chunk) = response.chunk().await.map_err(|_| "视频下载中断，请重试下载")? {
        file.write_all(&chunk).map_err(|e| format!("写入视频失败：{e}"))?;
        song.downloaded_bytes += chunk.len() as u64;
        if last_update.elapsed() >= Duration::from_secs(1) { persist(song)?; last_update = Instant::now(); }
    }
    if song.downloaded_bytes == 0 || song.total_bytes.is_some_and(|size| size != song.downloaded_bytes) { return Err("视频下载不完整，请重试下载".into()); }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temporary, target).map_err(|e| format!("保存视频失败：{e}"))?;
    song.local_path = Some(target.to_string_lossy().into());
    Ok(())
}

#[tauri::command]
pub fn songs_open_folder(app: tauri::AppHandle, _manager: State<'_, SongManager>) -> Result<(), String> {
    let path = directory(&app)?.join("videos");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe").arg(&path).creation_flags(0x08000000).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))] {
        std::process::Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" }).arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Read, net::TcpListener, thread};

    fn cleanup(path: PathBuf) {
        let resolved = path.canonicalize().unwrap();
        assert_eq!(resolved.parent().unwrap(), std::env::temp_dir().canonicalize().unwrap());
        assert!(resolved.file_name().unwrap().to_string_lossy().starts_with("songs-test-"));
        fs::remove_dir_all(resolved).unwrap();
    }

    fn request(mode: &str) -> SongRequest {
        SongRequest { title: "晚晚测试歌曲".into(), avatar_id: Some("avatar-one".into()), avatar_name: Some("晚晚".into()), premium_mv_mode: mode.into(), lip_ref_urls: Some("data:image/png;base64,YWJj".into()), images: None,
            audio_url: "data:audio/mpeg;base64,YWJj".into(), audio_duration: 60.0, prompt: "正对镜头演唱".into(), aspect_ratio: "16:9".into(), resolution: "720p".into(), add_subtitle: false }
    }

    fn song() -> Song {
        Song { id: uuid::Uuid::new_v4().to_string(), task_id: Some("task-existing".into()), title: "晚晚测试歌曲".into(), avatar_id: Some("avatar-one".into()), avatar_name: Some("晚晚".into()), mode: "sing".into(), region: "cn".into(), resolution: "720p".into(), aspect_ratio: "16:9".into(),
            created_at: 1, status: "created".into(), progress: None, downloaded_bytes: 0, total_bytes: None, local_path: None, error: None, available: false }
    }

    #[test]
    fn singing_uses_premium_fields_and_optional_scene_without_local_metadata() {
        for mode in ["sing", "sing_perform"] {
            let body = payload(&request(mode)).unwrap();
            assert_eq!(body["premium_mv_mode"], mode);
            assert_eq!(body["lip_ref_urls"], serde_json::json!(["data:image/png;base64,YWJj"]));
            assert!(body.get("images").is_none());
            assert!(body.get("audio_duration").is_none());
            assert!(body.get("title").is_none());
            assert!(body.get("avatar_id").is_none());
            assert!(body.get("avatar_name").is_none());
            assert!(body.get("lip_sync").is_none());
            let mut missing = request(mode); missing.lip_ref_urls = None;
            assert!(payload(&missing).is_err());
        }
        for mode in ["perform", "dance"] {
            let mut r = request(mode);
            assert!(payload(&r).is_err());
            r.images = Some("data:image/jpeg;base64,YWJj".into());
            let body = payload(&r).unwrap();
            assert!(body.get("lip_ref_urls").is_none());
            assert_eq!(body["images"], serde_json::json!(["data:image/jpeg;base64,YWJj"]));
        }
    }

    #[test]
    fn rejects_invalid_uploads_duration_modes_and_generation_settings_before_submission() {
        for duration in [0.0, 9.9, 300.1, f64::NAN, f64::INFINITY] {
            let mut r = request("sing"); r.audio_duration = duration; assert!(payload(&r).is_err());
        }
        for duration in [10.0, 300.0] { let mut r = request("sing"); r.audio_duration = duration; assert!(payload(&r).is_ok()); }
        assert!(payload(&request("unknown")).is_err());
        for resolution in ["720p", "1080p"] {
            let mut r = request("sing"); r.resolution = resolution.into();
            assert_eq!(payload(&r).unwrap()["resolution"], resolution);
        }
        let mut r = request("sing"); r.resolution = "540p".into(); assert!(payload(&r).is_err());
        let mut r = request("sing"); r.prompt = "字".repeat(3001); assert!(payload(&r).is_err());
        let mut r = request("sing"); r.title = " ".into(); assert!(payload(&r).is_err());
        for data in ["data:audio/mpeg;base64,", "data:audio/mpeg;base64,%%%%", "data:audio/mpeg;base64,YWJj===", "data:image/png;base64,YWJj"] {
            assert!(validate_media(data, "audio", 100).is_err());
        }
        assert!(validate_media("data:audio/mpeg;base64,YWJj", "audio", 3).is_err());
    }

    #[test]
    fn saved_avatar_urls_and_binding_are_validated_without_sending_local_metadata_to_vidu() {
        let mut r = request("sing");
        r.lip_ref_urls = Some("https://images.example/portrait.png?token=public-link".into());
        let body = payload(&r).unwrap();
        assert_eq!(body["lip_ref_urls"], serde_json::json!([r.lip_ref_urls.as_deref().unwrap()]));
        assert!(body.get("avatar_id").is_none()); assert!(body.get("avatar_name").is_none());
        for url in ["file:///C:/face.png", "javascript:alert(1)", "https://user:pass@example.com/photo.png", "invalid"] {
            assert!(validate_portrait(url).is_err());
        }
        r.avatar_name = None; assert!(payload(&r).is_err());
        r.avatar_id = None; assert!(payload(&r).is_ok());
    }

    #[test]
    fn songs_created_before_avatar_binding_remain_readable() {
        let mut value = serde_json::to_value(song()).unwrap();
        value.as_object_mut().unwrap().remove("avatar_id");
        value.as_object_mut().unwrap().remove("avatar_name");
        let legacy: Song = serde_json::from_value(value).unwrap();
        assert!(legacy.avatar_id.is_none()); assert!(legacy.avatar_name.is_none());
        assert_eq!(legacy.task_id.as_deref(), Some("task-existing"));
    }

    #[test]
    fn codec_errors_remove_uploaded_files_and_keys_and_repair_old_uncertain_rows() {
        let raw = format!("Vidu HTTP 400 Bad Request: body unmarshal proto: unexpected token \"data:image/png;base64,{}\" reason: CODEC key=vda_mock-secret", "YWFh".repeat(500_000));
        let clean = safe_error(&raw, "");
        assert!(clean.contains("body unmarshal proto")); assert!(clean.contains("CODEC"));
        assert!(!clean.contains("YWFh")); assert!(!clean.contains("vda_mock-secret")); assert!(clean.chars().count() <= 801);
        let mut old = song(); old.task_id = None; old.status = "submission_unknown".into(); old.error = Some(raw);
        assert!(repair_saved_error(&mut old)); assert_eq!(old.status, "submission_failed");
        assert!(old.error.as_ref().unwrap().len() < 500); assert!(!repair_saved_error(&mut old));
        let mut known = song(); known.status = "processing".into(); known.error = Some("HTTP 400 body unmarshal proto".into());
        repair_saved_error(&mut known); assert_eq!(known.status, "processing"); assert!(known.task_id.is_some());
    }

    #[test]
    fn an_explicit_rejection_does_not_ask_for_task_recovery_but_an_uncertain_response_does() {
        let mut rejected = song(); rejected.task_id = None;
        let message = submission_error(&mut rejected, SubmitError::Rejected("HTTP 400: CODEC".into()));
        assert_eq!(rejected.status, "submission_failed"); assert!(!message.contains("恢复查询"));
        let mut uncertain = song(); uncertain.task_id = None;
        let message = submission_error(&mut uncertain, SubmitError::Uncertain("响应超时".into()));
        assert_eq!(uncertain.status, "submission_unknown"); assert!(message.contains("核对任务"));
    }

    #[test]
    fn insufficient_credits_explain_the_account_region_and_keep_failed_tasks_terminal() {
        let mut polled = song(); polled.region = "global".into();
        apply_status(&mut polled, &serde_json::json!({"state":"failed", "err_code":"CreditInsufficient"})).unwrap();
        assert_eq!(polled.status, "failed"); assert!(!resumable(&polled.status));
        let message = polled.error.as_deref().unwrap();
        assert!(message.contains("国际区 API 账户积分不足")); assert!(message.contains("补足后重新生成"));
        let mut rejected = song(); rejected.task_id = None;
        let message = submission_error(&mut rejected, SubmitError::Rejected("HTTP 400: CreditInsufficient".into()));
        assert_eq!(rejected.status, "submission_failed"); assert!(message.contains("中国区 API 账户积分不足"));
        let mut legacy = polled.clone(); legacy.error = Some("生成失败：CreditInsufficient".into());
        assert!(repair_saved_error(&mut legacy)); assert_eq!(legacy.error, polled.error);
        assert_eq!(legacy.task_id, polled.task_id); assert_eq!(legacy.status, "failed");
        assert!(!repair_saved_error(&mut legacy));
    }

    fn premium_mock() -> (String, thread::JoinHandle<Value>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/ent/v2/one-click/premium_mv", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut received = Vec::new(); let mut buf = [0u8; 4096];
            let (header_end, length) = loop {
                let count = socket.read(&mut buf).unwrap(); assert!(count > 0); received.extend_from_slice(&buf[..count]);
                if let Some(end) = received.windows(4).position(|b| b == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&received[..end]);
                    assert!(headers.starts_with("POST /ent/v2/one-click/premium_mv "));
                    assert!(headers.to_lowercase().contains("authorization: token mock-only-key"));
                    let length = headers.lines().find_map(|line| line.split_once(':').filter(|(key, _)| key.eq_ignore_ascii_case("content-length")).map(|(_, value)| value.trim().parse::<usize>().unwrap())).unwrap();
                    break (end + 4, length);
                }
            };
            while received.len() < header_end + length { let count = socket.read(&mut buf).unwrap(); assert!(count > 0); received.extend_from_slice(&buf[..count]); }
            let body: Value = serde_json::from_slice(&received[header_end..header_end + length]).unwrap();
            // Match the server's repeated protobuf fields independently of the UI's single-file input.
            #[derive(Deserialize)]
            struct PremiumWire { lip_ref_urls: Vec<String>, #[serde(default)] images: Vec<String>, audio_url: String }
            let (status, response) = match serde_json::from_value::<PremiumWire>(body.clone()) {
                Ok(request) => {
                    assert_eq!(request.lip_ref_urls.len(), 1); assert!(request.images.len() <= 1); assert!(request.audio_url.starts_with("data:audio/"));
                    ("200 OK", serde_json::json!({"id":"mock-created-task"}))
                }
                Err(_) => ("400 Bad Request", serde_json::json!({"code":400,"message":format!("body unmarshal proto: unexpected token {}", body["lip_ref_urls"]),"reason":"CODEC"})),
            };
            let response = response.to_string();
            write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
            body
        });
        (url, handle)
    }

    #[tokio::test]
    async fn premium_mv_sends_reference_arrays_over_http_for_both_base64_and_url_photos() {
        for portrait in ["data:image/png;base64,YWJj", "https://images.example/face.png"] {
            let mut r = request("sing"); r.lip_ref_urls = Some(portrait.into()); r.images = Some("data:image/png;base64,YWJj".into());
            let body = payload(&r).unwrap();
            let (url, server) = premium_mock();
            assert_eq!(create_task(&client(5).unwrap(), &url, "mock-only-key", &body).await.unwrap(), "mock-created-task");
            let sent = server.join().unwrap();
            assert!(sent["lip_ref_urls"].is_array()); assert_eq!(sent["lip_ref_urls"][0], portrait);
            assert!(sent["images"].is_array()); assert!(sent.get("avatar_id").is_none());
        }
    }

    #[tokio::test]
    async fn the_original_scalar_reference_error_is_rejected_without_echoing_the_file() {
        let mut body = payload(&request("sing")).unwrap();
        body["lip_ref_urls"] = serde_json::json!("data:image/png;base64,YWJj");
        let (url, server) = premium_mock();
        let error = create_task(&client(5).unwrap(), &url, "mock-only-key", &body).await.unwrap_err();
        server.join().unwrap();
        match error {
            SubmitError::Rejected(message) => { assert!(message.contains("400")); assert!(message.contains("body unmarshal proto")); assert!(!message.contains("YWJj")); }
            _ => panic!("an explicit CODEC rejection must not become an uncertain submission"),
        }
    }

    #[test]
    fn statuses_keep_real_progress_and_do_not_call_remote_success_a_local_success() {
        let mut s = song();
        apply_status(&mut s, &serde_json::json!({"state":"queueing"})).unwrap();
        assert_eq!(s.progress, None);
        apply_status(&mut s, &serde_json::json!({"state":"processing","progress":42})).unwrap();
        assert_eq!(s.progress, Some(42.0));
        apply_status(&mut s, &serde_json::json!({"state":"success"})).unwrap();
        assert_eq!(s.status, "downloading"); assert!(!s.available);
        apply_status(&mut s, &serde_json::json!({"state":"failed","err_code":"AudioInvalid"})).unwrap();
        assert!(s.error.unwrap().contains("AudioInvalid"));
        assert!(apply_status(&mut song(), &serde_json::json!({"unexpected":true})).is_err());
    }

    #[test]
    fn restart_preserves_task_id_without_uploads_or_keys() {
        let path = std::env::temp_dir().join(format!("songs-test-{}", uuid::Uuid::new_v4()));
        let s = song();
        { let db = database(&path).unwrap(); save_to(&db, &s).unwrap(); }
        let db = database(&path).unwrap();
        let text: String = db.query_row("SELECT body FROM songs", [], |row| row.get(0)).unwrap();
        let loaded: Song = serde_json::from_str(&text).unwrap();
        assert_eq!(loaded.task_id, s.task_id); assert!(resumable(&loaded.status));
        assert_eq!(loaded.avatar_id, s.avatar_id); assert_eq!(loaded.avatar_name, s.avatar_name);
        assert!(!text.contains("base64")); assert!(!text.contains("audio_url")); assert!(!text.contains("key"));
        assert!(!resumable("success")); assert!(!resumable("failed")); assert!(!resumable("submission_unknown"));
        drop(db); cleanup(path);
    }

    #[test]
    fn deleting_terminal_cards_removes_owned_files_and_prevents_late_writes_after_restart() {
        let path = std::env::temp_dir().join(format!("songs-test-{}", uuid::Uuid::new_v4()));
        let mut db = database(&path).unwrap();
        let active = song(); save_to(&db, &active).unwrap();
        let unrelated = path.join("unrelated.mp4"); fs::write(&unrelated, b"keep").unwrap();
        let mut deleted = Vec::new();
        for status in ["success", "failed", "submission_failed", "download_failed"] {
            let mut terminal = song(); terminal.status = status.into();
            // A stored local_path must never authorize removal of an unrelated file.
            terminal.local_path = Some(unrelated.to_string_lossy().into());
            save_to(&db, &terminal).unwrap();
            let video = path.join("videos").join(format!("{}.mp4", terminal.id));
            let partial = video.with_extension("mp4.part");
            fs::write(&video, b"video").unwrap(); fs::write(&partial, b"partial").unwrap();
            delete_from(&mut db, &path, &terminal.id).unwrap();
            delete_from(&mut db, &path, &terminal.id).unwrap();
            assert!(!video.exists()); assert!(!partial.exists()); assert!(unrelated.exists());
            assert!(save_to(&db, &terminal).is_err());
            deleted.push(terminal);
        }
        drop(db);
        let db = database(&path).unwrap();
        for terminal in deleted { assert!(save_to(&db, &terminal).is_err()); }
        let remaining: Vec<String> = db.prepare("SELECT id FROM songs").unwrap()
            .query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(remaining, vec![active.id]);
        drop(db); cleanup(path);
    }

    #[test]
    fn deletion_rejects_active_and_uncertain_tasks_without_removing_records_or_files() {
        let path = std::env::temp_dir().join(format!("songs-test-{}", uuid::Uuid::new_v4()));
        let mut db = database(&path).unwrap();
        for status in ["created", "queueing", "processing", "downloading", "submitting", "submission_unknown", "unknown_future_state"] {
            let mut protected = song(); protected.status = status.into(); protected.task_id = None;
            save_to(&db, &protected).unwrap();
            let partial = path.join("videos").join(format!("{}.mp4.part", protected.id));
            fs::write(&partial, b"keep").unwrap();
            assert!(delete_from(&mut db, &path, &protected.id).is_err());
            assert_eq!(fs::read(&partial).unwrap(), b"keep");
            assert!(save_to(&db, &protected).is_ok());
        }
        assert!(delete_from(&mut db, &path, "../unrelated").is_err());
        assert_eq!(db.query_row("SELECT COUNT(*) FROM songs", [], |row| row.get::<_, i64>(0)).unwrap(), 7);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM deleted_songs", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        drop(db); cleanup(path);
    }

    #[test]
    fn file_removal_failure_preserves_the_card_and_does_not_mark_it_deleted() {
        let path = std::env::temp_dir().join(format!("songs-test-{}", uuid::Uuid::new_v4()));
        let mut db = database(&path).unwrap();
        let mut terminal = song(); terminal.status = "success".into(); save_to(&db, &terminal).unwrap();
        let video = path.join("videos").join(format!("{}.mp4", terminal.id));
        fs::create_dir(&video).unwrap();
        assert!(delete_from(&mut db, &path, &terminal.id).is_err());
        assert!(video.is_dir());
        assert_eq!(db.query_row("SELECT COUNT(*) FROM songs", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM deleted_songs", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert!(save_to(&db, &terminal).is_ok());
        drop(db); cleanup(path);
    }

    fn serve(status: &str, body: &str, length: usize) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/song.mp4", listener.local_addr().unwrap());
        let response = format!("HTTP/1.1 {status}\r\nContent-Type: video/mp4\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{body}");
        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut received = Vec::new(); let mut buf = [0u8; 1024];
            loop { let count = socket.read(&mut buf).unwrap(); if count == 0 { break; } received.extend_from_slice(&buf[..count]); if received.windows(4).any(|b| b == b"\r\n\r\n") { break; } }
            socket.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&received).into()
        });
        (url, handle)
    }

    #[tokio::test]
    async fn interrupted_download_is_never_published_and_retry_saves_complete_file_without_key() {
        let path = std::env::temp_dir().join(format!("songs-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        let target = path.join("video.mp4"); let mut s = song();
        let (url, server) = serve("200 OK", "partial", 100);
        assert!(download_to(&mut s, &url, &target, |_| Ok(())).await.is_err());
        server.join().unwrap(); assert!(!target.exists()); assert!(s.local_path.is_none());
        let (url, server) = serve("200 OK", "complete-video", 14);
        download_to(&mut s, &url, &target, |_| Ok(())).await.unwrap();
        let headers = server.join().unwrap(); assert!(!headers.to_lowercase().contains("authorization"));
        assert_eq!(fs::read(&target).unwrap(), b"complete-video"); assert_eq!(s.downloaded_bytes, 14);
        assert!(!target.with_extension("mp4.part").exists());
        // Simulate restart after rename but before recording local_path.
        s.local_path = None;
        download_to(&mut s, "invalid-expired-url", &target, |_| Ok(())).await.unwrap();
        assert_eq!(s.local_path, Some(target.to_string_lossy().into()));
        cleanup(path);
    }

    #[tokio::test]
    async fn failed_download_retains_task_and_never_creates_a_final_video() {
        let path = std::env::temp_dir().join(format!("songs-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap(); let target = path.join("video.mp4"); let mut s = song();
        let (url, server) = serve("403 Forbidden", "expired", 7);
        assert!(download_to(&mut s, &url, &target, |_| Ok(())).await.unwrap_err().contains("403"));
        server.join().unwrap(); assert!(!target.exists()); assert_eq!(s.task_id.as_deref(), Some("task-existing"));
        cleanup(path);
    }
}
