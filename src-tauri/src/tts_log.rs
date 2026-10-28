use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::VecDeque, fs::{self, File, OpenOptions}, io::{BufRead, BufReader, Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, sync::Mutex};
use tauri::{Emitter, Manager};

const MAX_ENTRIES: usize = 300;
const MAX_BYTES: u64 = 2 * 1024 * 1024;
static STORAGE: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Entry {
    id: String, at_ms: u128, live_id: String, command: String, content: String,
    msg_id: Option<String>, seq_id: Option<u64>, status: String, error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("douyin-live/data");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?; Ok(directory)
}

// Extract only outbound instruction content; never copy an entire protocol
// frame, which may carry credentials or other unrelated session data.
fn entry(live_id: &str, signal: &Value, error: Option<&str>) -> Option<Entry> {
    let (command, value) = match signal["type"].as_u64()? {
        100 => ("text_tts", &signal["payload"]["text_tts"]),
        101 => ("text_action", &signal["payload"]["text_action"]),
        99 => ("text_msg", &signal["payload"]["text_msg"]),
        102 => ("text_dialog", &signal["payload"]["text_dialog"]),
        9 => ("input_transcription", &signal["payload"]["text_msg"]),
        10 => ("output_transcription", &signal["payload"]["text_msg"]),
        97 => ("action_description", &signal["payload"]["session_update"]),
        7 => ("interrupt", &Value::Null),
        _ => return None,
    };
    let content = if command == "interrupt" { "打断当前输出" } else if command == "action_description" { value["action_description"].as_str()? } else { value["content"].as_str()? };
    let command = if command == "input_transcription" && value["msg_id"].as_str().is_some_and(|id| id.starts_with("avatar-action-") || id.starts_with("gift-action-") || id.starts_with("handoff-")) { "action_trigger" } else { command };
    Some(Entry {
        id:uuid::Uuid::new_v4().to_string(), at_ms:crate::unix_ms(), live_id:live_id.into(), command:command.into(), content:content.into(),
        msg_id:value["msg_id"].as_str().map(str::to_owned), seq_id:signal["seq_id"].as_u64(),
        status:if error.is_some() { "failed" } else { "sent" }.into(), error:error.map(str::to_owned), detail:None,
    })
}

fn append(directory: &Path, entry: &Entry) -> Result<(), String> {
    let path = directory.join("tts-log.jsonl");
    if fs::metadata(&path).is_ok_and(|metadata| metadata.len() >= MAX_BYTES) {
        fs::copy(&path, directory.join("tts-log.previous.jsonl")).map_err(|e| e.to_string())?;
        fs::write(&path, "").map_err(|e| e.to_string())?;
    }
    let mut file = OpenOptions::new().create(true).read(true).append(true).open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > 0 {
        file.seek(SeekFrom::End(-1)).map_err(|e| e.to_string())?;
        let mut last = [0u8; 1]; file.read_exact(&mut last).map_err(|e| e.to_string())?;
        // Separate a partial record left by a crash from the next valid entry.
        if last[0] != b'\n' { file.write_all(b"\n").map_err(|e| e.to_string())?; }
    }
    writeln!(file, "{}", serde_json::to_string(entry).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

pub fn record(app: &tauri::AppHandle, live_id: &str, signal: &Value, error: Option<&str>) {
    let Some(entry) = entry(live_id, signal, error) else { return; };
    persist(app, &entry);
}

fn persist(app: &tauri::AppHandle, entry: &Entry) {
    let result = (|| {
        let _guard = STORAGE.lock().map_err(|e| e.to_string())?;
        append(&directory(app)?, &entry)
    })();
    // Surface the actual send even when local storage is unavailable.
    let _ = app.emit("tts-log-entry", &entry);
    if let Err(error) = result { let _ = app.emit("tts-log-error", format!("TTS 日志保存失败：{error}")); }
}

pub fn record_rejection(app: &tauri::AppHandle, live_id: &str, signal: &Value) {
    let error = signal.pointer("/payload/error").unwrap_or(&signal["payload"]);
    let Some(msg_id) = error["msg_id"].as_str() else { return; };
    let previous = (|| -> Result<Option<Entry>, String> {
        let _guard = STORAGE.lock().map_err(|e| e.to_string())?;
        Ok(read_recent(&directory(app)?)?.into_iter().find(|entry| entry.live_id == live_id && entry.msg_id.as_deref() == Some(msg_id) && entry.status == "sent"))
    })();
    if let Ok(Some(mut entry)) = previous {
        entry.id = uuid::Uuid::new_v4().to_string(); entry.at_ms = crate::unix_ms(); entry.status = "failed".into();
        entry.error = Some(format!("Vidu 拒绝指令：{}", error["error_msg"].as_str().or_else(|| error["message"].as_str()).unwrap_or("服务端指令错误")));
        persist(app, &entry);
    }
}

#[derive(Deserialize)]
pub struct SongObservation {
    index: u32, text: String, status: String, position_ms: u64,
    latency_ms: Option<u64>, offset_ms: Option<i64>,
}

#[tauri::command]
pub fn tts_log_song_observation(app: tauri::AppHandle, live_id: String, msg_id: String, observation: SongObservation) -> Result<(), String> {
    if live_id.is_empty() || live_id.len() > 128 || msg_id.is_empty() || msg_id.len() > 200 || observation.index >= 2000 || observation.text.chars().count() > 300 || observation.position_ms > 1_800_000 {
        return Err("歌曲同步记录无效".into());
    }
    let detail = match observation.status.as_str() {
        "audio_detected" => format!("第{}段 · 原歌曲 {:.3} 秒 · 提交至下行发声 {} ms · 相对歌词开始 {:+} ms。仅依据静音后的发声推测对应，未验证视频口型。", observation.index+1, observation.position_ms as f64/1000.0, observation.latency_ms.unwrap_or(0), observation.offset_ms.unwrap_or(0)),
        "unconfirmed" => format!("第{}段 · 原歌曲 {:.3} 秒 · 未检测到可对应的下行发声，不能确认 Vidu 已生成。", observation.index+1, observation.position_ms as f64/1000.0),
        "overlap" => format!("第{}段 · 原歌曲 {:.3} 秒 · 下行音频检测不可用、上一句仍在发声或静音不足，无法独立测量本句延迟。", observation.index+1, observation.position_ms as f64/1000.0),
        "skipped" => format!("第{}段 · 原歌曲 {:.3} 秒 · 歌词已过期，跳过发送以免补发造成错位。", observation.index+1, observation.position_ms as f64/1000.0),
        _ => return Err("歌曲同步状态无效".into()),
    };
    persist(&app, &Entry { id:uuid::Uuid::new_v4().to_string(), at_ms:crate::unix_ms(), live_id, msg_id:Some(msg_id), seq_id:None,
        command:"song_sync".into(), content:observation.text, status:observation.status, error:None, detail:Some(detail) });
    Ok(())
}

fn read_recent(directory: &Path) -> Result<Vec<Entry>, String> {
    let mut entries = VecDeque::new();
    for name in ["tts-log.previous.jsonl", "tts-log.jsonl"] {
        let file = match File::open(directory.join(name)) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        for line in BufReader::new(file).lines() {
            let line = line.map_err(|e| e.to_string())?;
            // A crash may leave an incomplete final line. Keep earlier records.
            if let Ok(entry) = serde_json::from_str::<Entry>(&line) {
                entries.push_back(entry);
                if entries.len() > MAX_ENTRIES { entries.pop_front(); }
            }
        }
    }
    Ok(entries.into_iter().rev().collect())
}

#[tauri::command]
pub fn tts_log_load(app: tauri::AppHandle) -> Result<Value, String> {
    let _guard = STORAGE.lock().map_err(|e| e.to_string())?;
    let directory = directory(&app)?;
    Ok(json!({"entries":read_recent(&directory)?,"path":directory.join("tts-log.jsonl").to_string_lossy()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn component_action_driver_is_logged_as_an_action_and_keeps_its_slot_id() {
        let log=entry("live",&json!({"type":9,"payload":{"text_msg":{"msg_id":"avatar-action-slot-1","content":"扎起马尾"}}}),None).unwrap();
        assert_eq!(log.command,"action_trigger");assert_eq!(log.msg_id.as_deref(),Some("avatar-action-slot-1"));
        let normal=entry("live",&json!({"type":9,"payload":{"text_msg":{"msg_id":"input-microphone-1","content":"你好"}}}),None).unwrap();
        assert_eq!(normal.command,"input_transcription");
    }
    #[test]
    fn dialogue_logs_retain_protocol_content_and_failures() {
        let (kind, payload) = crate::manual_question_signal("今天聊什么？", Some("text_dialog")).unwrap();
        let signal = json!({"type":kind,"payload":payload,"seq_id":102});
        let log = entry("live", &signal, None).unwrap();
        assert_eq!(log.command, "text_dialog"); assert_eq!(log.content, "今天聊什么？");
        assert!(log.msg_id.is_some()); assert_eq!(log.seq_id, Some(102));
        let failed = entry("live", &signal, Some("连接关闭")).unwrap();
        assert_eq!(failed.status, "failed"); assert_eq!(failed.content, log.content);
    }

    #[test]
    fn text_messages_preserve_lyrics_and_correlated_write_failures() {
        let (kind, payload) = crate::speech_message_signal("第一句歌词\n第二句", Some("attempt-4".into())).unwrap();
        let signal = json!({"type":kind,"seq_id":101,"payload":payload});
        let log = entry("live-1", &signal, None).unwrap();
        assert_eq!(log.command, "text_msg");
        assert_eq!(log.content, "第一句歌词\n第二句");
        assert_eq!(log.msg_id.as_deref(), Some("tts-attempt-4"));
        assert_eq!(log.seq_id, Some(101));
        let failed = entry("live-1", &signal, Some("控制连接写入失败")).unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.content, log.content);
        assert_eq!(failed.msg_id, log.msg_id);
    }

    #[test]
    fn logs_exact_lyrics_and_actions_without_copying_tokens_or_incoming_frames() {
        let signal = json!({"type":100,"seq_id":101,"key":"secret-key","rtc":{"token":"secret-token"},"payload":{"text_tts":{"msg_id":"tts-attempt-4","content":"第一句歌词\n第二句"}}});
        let log = entry("live-1", &signal, None).unwrap();
        assert_eq!(log.content, "第一句歌词\n第二句"); assert_eq!(log.msg_id.as_deref(), Some("tts-attempt-4"));
        assert_eq!(log.live_id,"live-1"); assert_eq!(log.status,"sent");
        let text = serde_json::to_string(&log).unwrap();
        assert!(!text.contains("secret-key")); assert!(!text.contains("secret-token"));
        let failed = entry("live-1", &signal, Some("控制连接写入失败")).unwrap();
        assert_eq!(failed.status,"failed"); assert_eq!(failed.content,log.content);
        let action = entry("live-1", &json!({"type":101,"payload":{"text_action":{"content":"目光注视前方"}}}), None).unwrap();
        assert_eq!(action.command,"text_action"); assert_eq!(action.content,"目光注视前方");
        assert_eq!(entry("live-1", &json!({"type":7,"payload":{}}), None).unwrap().content,"打断当前输出");
        for kind in [1,2,5,6,9,10,103] { assert!(entry("live-1", &json!({"type":kind}), None).is_none()); }
    }

    #[test]
    fn recent_logs_survive_restart_and_ignore_partial_lines_with_bounded_history() {
        let directory = std::env::temp_dir().join(format!("tts-log-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let mut log = entry("live", &json!({"type":100,"payload":{"text_tts":{"content":"歌词"}}}), None).unwrap();
        for index in 0..305 { log.content = index.to_string(); append(&directory,&log).unwrap(); }
        let mut file = OpenOptions::new().append(true).open(directory.join("tts-log.jsonl")).unwrap();
        write!(file,"{{partial").unwrap(); drop(file);
        let loaded = read_recent(&directory).unwrap();
        assert_eq!(loaded.len(),300); assert_eq!(loaded[0].content,"304"); assert_eq!(loaded[299].content,"5");
        log.content = "after-restart".into(); append(&directory,&log).unwrap();
        assert_eq!(read_recent(&directory).unwrap()[0].content,"after-restart");
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn rotating_logs_keep_the_previous_file_and_recent_entries_in_order() {
        let directory = std::env::temp_dir().join(format!("tts-log-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let mut log = entry("live", &json!({"type":100,"payload":{"text_tts":{"content":"第一句"}}}), None).unwrap();
        append(&directory,&log).unwrap();
        let mut file = OpenOptions::new().append(true).open(directory.join("tts-log.jsonl")).unwrap();
        file.write_all(&vec![b' '; MAX_BYTES as usize]).unwrap(); drop(file);
        log.content = "第二句".into(); append(&directory,&log).unwrap();
        assert!(directory.join("tts-log.previous.jsonl").is_file());
        let loaded = read_recent(&directory).unwrap();
        assert_eq!(loaded.len(),2); assert_eq!(loaded[0].content,"第二句"); assert_eq!(loaded[1].content,"第一句");
        fs::remove_dir_all(&directory).unwrap();
    }
}
