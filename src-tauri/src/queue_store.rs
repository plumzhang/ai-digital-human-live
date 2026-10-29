use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}, sync::Mutex};
use tauri::{Manager, State};

pub(crate) const INTERACTION_SLOT_COUNT: usize = 3;

#[derive(Default)]
pub struct QueueStorage(Mutex<Option<Store>>);
struct Store { db: Connection, directory: PathBuf }

pub(crate) fn atomic_write(directory: &Path, name: &str, text: &str) -> Result<(), String> {
    let target = directory.join(name);
    let temporary = directory.join(format!(".{name}.tmp"));
    fs::write(&temporary, text).map_err(|error| error.to_string())?;
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" { fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32; }
        let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } == 0 { return Err(std::io::Error::last_os_error().to_string()); }
    }
    #[cfg(not(windows))]
    fs::rename(temporary, target).map_err(|error| error.to_string())?;
    Ok(())
}

fn open_store(directory: PathBuf) -> Result<Store, String> {
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let db = Connection::open(directory.join("live.db")).map_err(|error| error.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL);").map_err(|error| error.to_string())?;
    Ok(Store { db, directory })
}

fn with_store<T>(app: &tauri::AppHandle, storage: &QueueStorage, work: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
    let mut guard = storage.0.lock().map_err(|error| error.to_string())?;
    if guard.is_none() {
        let directory = app.path().app_data_dir().map_err(|error| error.to_string())?.join("douyin-live").join("data");
        *guard = Some(open_store(directory)?);
    }
    work(guard.as_mut().unwrap())
}

fn clean_line(value: &str) -> String { value.replace(['\r', '\n'], " ").replace("//", "／／") }

fn export_state(store: &Store, snapshot: &Value) -> Result<(), String> {
    let tasks = snapshot.get("tasks").and_then(Value::as_array).ok_or("队列快照缺少 tasks")?;
    let mut lines = Vec::new();
    for task in tasks {
        let event = &task["event"];
        let nickname = clean_line(event["nickname"].as_str().unwrap_or("观众"));
        let content = clean_line(event["content"].as_str().unwrap_or(""));
        let left = if event["type"] == "song" { format!("[歌曲][{nickname}] {content}") } else if event["type"] == "gift" { format!("[礼物][{nickname}][{content}]") } else { format!("[弹幕][{nickname}] {content}") };
        let right = if let Some(duration) = task.pointer("/song/duration_ms").and_then(Value::as_u64) { format!("歌曲导播 · {:.1}秒", duration as f64 / 1000.0) } else { task.pointer("/result/prepared_reply").or_else(||task.pointer("/result/speech")).and_then(Value::as_str).map(clean_line).unwrap_or_else(|| match task["status"].as_str() {
            Some("generating") => "生成中", Some("failed") => "生成失败", Some("uncertain") => "等待确认", _ => "等待生成",
        }.into()) };
        lines.push(format!("{left}//{right}"));
    }
    lines.resize(INTERACTION_SLOT_COUNT, String::new());
    atomic_write(&store.directory, "queue.txt", &(lines.join("\n") + "\n"))?;
    atomic_write(&store.directory, "queue.json", &serde_json::to_string_pretty(snapshot).map_err(|error| error.to_string())?)?;
    let playing = tasks.iter().find(|task| matches!(task["status"].as_str(), Some("playing" | "uncertain"))).unwrap_or(&Value::Null);
    atomic_write(&store.directory, "playing.json", &serde_json::to_string_pretty(playing).map_err(|error| error.to_string())?)?;
    Ok(())
}

fn repair_logs(store: &Store) -> Result<(), String> {
    // Rebuild mirrors on startup, not on every live event or state change.
    for (table, name) in [("events", "events.jsonl"), ("history", "history.jsonl")] {
        let mut statement = store.db.prepare(&format!("SELECT body FROM {table} ORDER BY rowid")).map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
        let mut output = String::new();
        for row in rows { output.push_str(&row.map_err(|error| error.to_string())?); output.push('\n'); }
        atomic_write(&store.directory, name, &output)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn queue_load(app: tauri::AppHandle, storage: State<'_, QueueStorage>) -> Result<Value, String> {
    with_store(&app, &storage, |store| {
        let snapshot = store.db.query_row("SELECT snapshot FROM state WHERE id=1", [], |row| row.get::<_, String>(0)).optional().map_err(|error| error.to_string())?
            .map(|text| serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())).transpose()?;
        repair_logs(store)?;
        let mut statement = store.db.prepare("SELECT id,body FROM events WHERE id NOT IN (SELECT id FROM receipts) ORDER BY rowid").map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|error| error.to_string())?;
        let mut pending = Vec::new();
        for row in rows {
            let (id, body) = row.map_err(|error| error.to_string())?;
            pending.push(json!({"event_id":id,"raw":serde_json::from_str::<Value>(&body).map_err(|error| error.to_string())?}));
        }
        Ok(json!({"snapshot":snapshot,"directory":store.directory.to_string_lossy(),"pending_events":pending}))
    })
}

#[tauri::command]
pub async fn queue_commit(app: tauri::AppHandle, storage: State<'_, QueueStorage>, snapshot: Value) -> Result<(), String> {
    with_store(&app, &storage, |store| commit_snapshot(store, &snapshot))
}

pub(crate) fn ensure_song_not_queued(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    with_store(app, &app.state::<QueueStorage>(), |store| {
        let snapshot = store.db.query_row("SELECT snapshot FROM state WHERE id=1", [], |row| row.get::<_, String>(0)).optional().map_err(|e| e.to_string())?;
        if let Some(text) = snapshot {
            let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if ["tasks", "deferred_tasks"].iter().any(|field| value[*field].as_array().is_some_and(|tasks| tasks.iter().any(|task| task.pointer("/song/id").and_then(Value::as_str) == Some(id)))) {
                return Err("歌曲已在互动队列中，请先完成或跳过，再编辑或删除".into());
            }
        }
        Ok(())
    })
}

fn commit_snapshot(store: &mut Store, snapshot: &Value) -> Result<(), String> {
    let tasks = snapshot["tasks"].as_array().ok_or("无效的队列快照")?;
    if tasks.len() > INTERACTION_SLOT_COUNT || tasks.iter().filter(|task| matches!(task["status"].as_str(), Some("playing" | "uncertain"))).count() > 1 || tasks.iter().filter(|task| task["status"] == "generating").count() > 2 {
        return Err(format!("队列超过 {INTERACTION_SLOT_COUNT} 个槽位或包含多个播报任务"));
    }
    let transaction = store.db.transaction().map_err(|error| error.to_string())?;
    let mut appended_history = Vec::new();
    transaction.execute("INSERT INTO state(id,snapshot) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot", [snapshot.to_string()]).map_err(|error| error.to_string())?;
    for task in tasks {
        transaction.execute("INSERT INTO tasks(id,body) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body", params![task["id"].as_str().ok_or("任务缺少 ID")?, task.to_string()]).map_err(|error| error.to_string())?;
    }
    if let Some(history) = snapshot["history"].as_array() {
        for entry in history {
            let inserted = transaction.execute("INSERT OR IGNORE INTO history(id,body) VALUES(?1,?2)", params![entry.pointer("/task/id").and_then(Value::as_str).ok_or("历史缺少任务 ID")?, entry.to_string()]).map_err(|error| error.to_string())?;
            if inserted > 0 { appended_history.push(entry.to_string()); }
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    if !appended_history.is_empty() {
        let mut file = OpenOptions::new().create(true).append(true).open(store.directory.join("history.jsonl")).map_err(|error| error.to_string())?;
        for entry in appended_history { writeln!(file, "{entry}").map_err(|error| error.to_string())?; }
    }
    export_state(store, &snapshot)

}

#[tauri::command]
pub async fn queue_archive_event(app: tauri::AppHandle, storage: State<'_, QueueStorage>, event_id: String, raw: Value) -> Result<bool, String> {
    with_store(&app, &storage, |store| {
        let inserted = store.db.execute("INSERT OR IGNORE INTO events(id,body) VALUES(?1,?2)", params![event_id, raw.to_string()]).map_err(|error| error.to_string())?;
        if inserted > 0 {
            let mut file = OpenOptions::new().create(true).append(true).open(store.directory.join("events.jsonl")).map_err(|error| error.to_string())?;
            writeln!(file, "{raw}").map_err(|error| error.to_string())?;
        }
        let acknowledged = store.db.query_row("SELECT EXISTS(SELECT 1 FROM receipts WHERE id=?1)", [&event_id], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
        Ok(!acknowledged)
    })
}

#[tauri::command]
pub async fn queue_ack_event(app: tauri::AppHandle, storage: State<'_, QueueStorage>, event_id: String) -> Result<(), String> {
    with_store(&app, &storage, |store| {
        store.db.execute("INSERT OR IGNORE INTO receipts(id) VALUES(?1)", [event_id]).map_err(|error| error.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn queue_save_config(app: tauri::AppHandle, storage: State<'_, QueueStorage>, persona: String, model: String, base_url: String) -> Result<(), String> {
    with_store(&app, &storage, |store| {
        atomic_write(&store.directory, "persona.txt", &persona)?;
        atomic_write(&store.directory, "config.json", &json!({"window_size":INTERACTION_SLOT_COUNT,"generation_concurrency":2,"playback_concurrency":1,"chat_expiry_seconds":30,"slot_expiry_seconds":null,"slot_replacement":"on_vacancy","gift_merge_ms":2000,"gift_priority":true,"model":model,"base_url":base_url}).to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_store() -> Store {
        open_store(std::env::temp_dir().join(format!("vidu-queue-test-{}", uuid::Uuid::new_v4()))).unwrap()
    }
    fn cleanup(store: Store) {
        let directory = store.directory.clone();
        drop(store);
        assert!(directory.starts_with(std::env::temp_dir()));
        assert!(directory.file_name().unwrap().to_string_lossy().starts_with("vidu-queue-test-"));
        fs::remove_dir_all(directory).unwrap();
    }
    fn snapshot() -> Value {
        json!({"version":1,"tasks":[
            {"id":"a","status":"playing","event":{"type":"chat","nickname":"小杰","content":"你好"},"result":{"speech":"小杰你好！"}},
            {"id":"b","status":"generating","event":{"type":"gift","nickname":"阿豪","content":"玫瑰×5"}},
            {"id":"c","status":"pending","event":{"type":"chat","nickname":"小宇","content":"在吗"}}
        ],"history":[],"candidates":[],"combos":{},"thanked_combos":{}})
    }

    #[test]
    fn sqlite_commit_exports_three_readable_lines_and_replaces_existing_snapshots() {
        let mut store = temporary_store();
        let first = snapshot();
        commit_snapshot(&mut store, &first).unwrap();
        let text = fs::read_to_string(store.directory.join("queue.txt")).unwrap();
        assert_eq!(text.lines().count(), 3);
        assert!(text.contains("[弹幕][小杰] 你好//小杰你好！"));
        assert!(text.contains("[礼物][阿豪][玫瑰×5]//生成中"));
        let mut second = first.clone();
        second["tasks"][0]["status"] = json!("uncertain");
        commit_snapshot(&mut store, &second).unwrap();
        let playing: Value = serde_json::from_str(&fs::read_to_string(store.directory.join("playing.json")).unwrap()).unwrap();
        assert_eq!(playing["status"], "uncertain");
        let saved: String = store.db.query_row("SELECT snapshot FROM state WHERE id=1", [], |row| row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), second);
        cleanup(store);
    }

    #[test]
    fn three_tasks_are_persisted_and_exported_and_a_fourth_is_rejected() {
        let mut store = temporary_store();
        let mut valid = snapshot();
        valid["deferred_tasks"] = json!([{"id":"old-song","status":"ready","song":{"id":"saved-song"}}]);
        commit_snapshot(&mut store, &valid).unwrap();
        let text = fs::read_to_string(store.directory.join("queue.txt")).unwrap();
        assert_eq!(text.lines().count(), 3);
        assert!(text.contains("[弹幕][小宇] 在吗//等待生成"));
        let mut invalid = valid.clone();
        invalid["tasks"].as_array_mut().unwrap().push(json!({"id":"d","status":"pending"}));
        assert!(commit_snapshot(&mut store, &invalid).is_err());
        let saved: String = store.db.query_row("SELECT snapshot FROM state WHERE id=1", [], |row| row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), valid);
        cleanup(store);
    }

    #[test]
    fn invalid_transition_rolls_back_database_and_history_is_idempotent() {
        let mut store = temporary_store();
        let mut valid = snapshot();
        valid["history"] = json!([{"task":{"id":"done"},"outcome":"played"}]);
        commit_snapshot(&mut store, &valid).unwrap();
        commit_snapshot(&mut store, &valid).unwrap();
        assert_eq!(store.db.query_row("SELECT COUNT(*) FROM history", [], |row| row.get::<_, u32>(0)).unwrap(), 1);
        let mut invalid = valid.clone();
        invalid["tasks"][0]["id"] = Value::Null;
        assert!(commit_snapshot(&mut store, &invalid).is_err());
        let saved: String = store.db.query_row("SELECT snapshot FROM state WHERE id=1", [], |row| row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), valid);
        invalid = valid.clone();
        invalid["tasks"][1]["status"] = json!("playing");
        assert!(commit_snapshot(&mut store, &invalid).is_err());
        cleanup(store);
    }

    #[test]
    fn unacknowledged_gifts_remain_recoverable_and_logs_can_be_rebuilt() {
        let store = temporary_store();
        store.db.execute("INSERT INTO events(id,body) VALUES(?1,?2)", params!["gift-1", r#"{"type":"gift","data":{"repeatCount":10}}"#]).unwrap();
        let pending: u32 = store.db.query_row("SELECT COUNT(*) FROM events WHERE id NOT IN (SELECT id FROM receipts)", [], |row| row.get(0)).unwrap();
        assert_eq!(pending, 1);
        repair_logs(&store).unwrap();
        assert!(fs::read_to_string(store.directory.join("events.jsonl")).unwrap().contains("repeatCount"));
        store.db.execute("INSERT INTO receipts(id) VALUES(?1)", ["gift-1"]).unwrap();
        let pending: u32 = store.db.query_row("SELECT COUNT(*) FROM events WHERE id NOT IN (SELECT id FROM receipts)", [], |row| row.get(0)).unwrap();
        assert_eq!(pending, 0);
        cleanup(store);
    }
}
