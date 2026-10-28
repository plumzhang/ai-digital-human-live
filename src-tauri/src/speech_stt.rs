use crate::component::{endpoint, TtsConfig};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

#[tauri::command]
pub async fn speech_prepare(tts: TtsConfig) -> Result<Value, String> {
    let data = crate::speech_runtime::service_health(&tts).await.map_err(|_| "请先启动 FunASR / OmniVoice 本机服务")?;
    crate::speech_runtime::validate_health(&data)?;
    Ok(json!({"ready":true,"model":data["stt"]["model"],"device":data["stt"]["device"]}))
}
#[derive(Deserialize)]
pub struct AudioRequest {
    live_id: String, task_id: String, capture_id: String,
    offset_ms: u64, captured_at: u64, samples: Vec<i16>,
}
fn validate(request: &AudioRequest) -> Result<(), String> {
    if [request.live_id.as_str(), request.task_id.as_str(), request.capture_id.as_str()].iter().any(|s| s.is_empty() || s.len() > 128)
        || !(1600..=400000).contains(&request.samples.len()) || request.offset_ms > 3_600_000 || request.captured_at == 0 {
        return Err("无效的 FunASR 音频批次（需单声道16kHz PCM，0.1–25秒）".into());
    }
    Ok(())
}
async fn post(tts: &TtsConfig, payload: Value, timeout: u64) -> Result<Value, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(timeout)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
    let response = client.post(endpoint(&tts.base_url, "api/stt")?).bearer_auth(&tts.key).json(&payload).send().await.map_err(|_| "FunASR 识别请求失败，请检查语音服务")?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|_| "FunASR 返回格式无效")?;
    if !status.is_success() { return Err(format!("FunASR HTTP {status}：{}", value["error"].as_str().unwrap_or("识别失败"))); }
    if !value["segments"].is_array() { return Err("FunASR 未返回识别字幕".into()); }
    Ok(value)
}
#[tauri::command]
pub async fn speech_transcribe(tts: TtsConfig, request: AudioRequest) -> Result<Value, String> {
    validate(&request)?;
    let pcm: Vec<u8> = request.samples.iter().flat_map(|s| s.to_le_bytes()).collect();
    let mut value = post(&tts, json!({"audio":base64::engine::general_purpose::STANDARD.encode(pcm),"sample_rate":16000,"format":"pcm_s16le","request_id":request.capture_id}), 125).await?;
    value["live_id"] = json!(request.live_id); value["task_id"] = json!(request.task_id); value["capture_id"] = json!(request.capture_id);
    value["offset_ms"] = json!(request.offset_ms); value["captured_at"] = json!(request.captured_at); value["enabled"] = json!(true);
    Ok(value)
}
pub async fn transcribe_file(tts: &TtsConfig, path: &std::path::Path) -> Result<Value, String> {
    post(tts, json!({"audio_path":path.to_string_lossy()}), 1210).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn audio_limits_bound_memory_and_preserve_capture_identity() {
        let mut r = AudioRequest { live_id:"live".into(), task_id:"microphone".into(), capture_id:"capture".into(),offset_ms:0,captured_at:1,samples:vec![0;1600] };
        assert!(validate(&r).is_ok()); r.samples.resize(400001,0); assert!(validate(&r).is_err());
        r.samples.truncate(1600); r.capture_id.clear(); assert!(validate(&r).is_err());
    }
    #[tokio::test]
    async fn funasr_receives_real_little_endian_pcm_and_returns_original_capture_identity() {
        use std::{io::{BufRead, BufReader, Read, Write}, net::TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let tts = TtsConfig { base_url:format!("http://{}",listener.local_addr().unwrap()),key:"speech-only".into(),model:crate::speech_runtime::MODEL.into(),ref_audio:String::new(),ref_text:String::new() };
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut first = String::new(); reader.read_line(&mut first).unwrap();
            assert_eq!(first, "POST /api/stt HTTP/1.1\r\n");
            let mut length = 0;
            loop { let mut line = String::new(); reader.read_line(&mut line).unwrap(); if line == "\r\n" { break; }
                if let Some(n) = line.to_lowercase().strip_prefix("content-length:") { length = n.trim().parse().unwrap(); } }
            let mut body = vec![0;length]; reader.read_exact(&mut body).unwrap();
            let payload: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(payload["sample_rate"],16000); assert_eq!(payload["format"],"pcm_s16le");
            let raw = base64::engine::general_purpose::STANDARD.decode(payload["audio"].as_str().unwrap()).unwrap();
            assert_eq!(&raw[..6], &[0,128,0,0,255,127]);
            let response = json!({"segments":[{"start_ms":0,"end_ms":100,"text":"中文"}],"inference_ms":10}).to_string();
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
        });
        let mut samples = vec![0;1600]; samples[..3].copy_from_slice(&[i16::MIN,0,i16::MAX]);
        let request = AudioRequest { live_id:"live".into(),task_id:"microphone".into(),capture_id:"capture".into(),offset_ms:123,captured_at:456,samples };
        let result = speech_transcribe(tts,request).await.unwrap();
        assert_eq!(result["capture_id"],"capture"); assert_eq!(result["offset_ms"],123); assert_eq!(result["captured_at"],456);
        assert_eq!(result["segments"][0]["text"],"中文"); server.join().unwrap();
    }
}
