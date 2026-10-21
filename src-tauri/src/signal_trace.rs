use serde_json::{json, Value};
use std::{fs::{self, OpenOptions}, io::Write};
use tauri::Manager;

// Keep only protocol metadata. Never persist credentials, RTC tokens, original
// audio/transcriptions, prompts or generated speech in this diagnostic log.
fn summary(live_id: &str, stage: &str, signal: &Value) -> Value {
    let kind = signal["type"].as_u64();
    let payload = &signal["payload"];
    let command = ["text_tts", "text_action", "text_msg", "text_dialog"].iter()
        .find_map(|name| payload.get(*name));
    json!({
        "at_ms": super::unix_ms(), "live_id": live_id, "stage": stage,
        "type": kind, "seq_id": signal.get("seq_id"),
        "msg_id": command.and_then(|value| value.get("msg_id")).or_else(|| payload.pointer("/error/msg_id")),
        "content_chars": command.and_then(|value| value["content"].as_str()).map(|text| text.chars().count()),
        "hangup_reason": payload.pointer("/hangup/hangup_reason"),
        "error_code": payload.pointer("/error/error_code").or_else(|| payload.pointer("/error/code")).or_else(|| payload.get("error_code")).or_else(|| payload.get("code")),
        "init_success": payload.pointer("/conn_init_ack/success"),
        "init_error_code": payload.pointer("/conn_init_ack/error_code")
    })
}

pub fn record(app: &tauri::AppHandle, live_id: &str, stage: &str, signal: &Value) {
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let directory = app.path().app_data_dir()?.join("douyin-live").join("data");
        fs::create_dir_all(&directory)?;
        let path = directory.join("vidu-signals.jsonl");
        if fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 2 * 1024 * 1024) {
            // One writer per session; keep the previous log as well.
            fs::copy(&path, directory.join("vidu-signals.previous.jsonl"))?;
            fs::write(&path, "")?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(file, "{}", summary(live_id, stage, signal))?;
        Ok(())
    })();
    if let Err(error) = result { eprintln!("Vidu diagnostic log unavailable: {error}"); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_excludes_content_and_credentials_and_links_commands_to_hangups() {
        let value = summary("live-1", "written", &json!({"type":100,"seq_id":12,"key":"secret-key","rtc":{"token":"rtc-secret"},"payload":{"text_tts":{"msg_id":"req-1","content":"私密台词"}}}));
        assert_eq!(value["content_chars"], 4);
        assert_eq!(value["msg_id"], "req-1");
        for secret in ["secret-key", "rtc-secret", "私密台词"] { assert!(!value.to_string().contains(secret)); }
        let closed = summary("live-1", "received", &json!({"type":6,"payload":{"hangup":{"hangup_reason":"ai_output_closed"}}}));
        assert_eq!(closed["live_id"], value["live_id"]);
        assert_eq!(closed["hangup_reason"], "ai_output_closed");
    }
}
