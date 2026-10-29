use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::{Path, PathBuf}, sync::Mutex};
use tauri::Manager;
use base64::Engine;

#[derive(Default)]
pub struct DirectorRuntime(Mutex<HashSet<String>>);
struct DirectorJob { app: tauri::AppHandle, id: String }
impl DirectorJob {
    fn acquire(app: &tauri::AppHandle, id: &str) -> Result<Self, String> {
        if !app.state::<DirectorRuntime>().0.lock().map_err(|e| e.to_string())?.insert(id.into()) { return Err("此歌曲导播正在处理中，请稍后重试".into()); }
        Ok(Self { app:app.clone(), id:id.into() })
    }
}
impl Drop for DirectorJob {
    fn drop(&mut self) { if let Ok(mut jobs) = self.app.state::<DirectorRuntime>().0.lock() { jobs.remove(&self.id); } }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Cue { pub start_ms: u64, pub end_ms: u64, pub text: String, pub lead_ms: u64 }
#[derive(Clone, Deserialize, Serialize)]
pub struct Director {
    id: String, title: String, created_at: u128, duration_ms: u64,
    audio_name: String, audio_file: String, lyrics: String, status: String,
    raw_segments: Vec<Cue>, cues: Vec<Cue>, error: Option<String>,
    #[serde(default)] pcm_lead_ms:u64,
}
#[derive(Deserialize)]
pub struct CreateRequest { title: String, audio_name: String, audio_data: String, duration_ms: u64, lyrics: String }

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("songs/directors");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?; Ok(path)
}
fn folder(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    let id = uuid::Uuid::parse_str(id).map_err(|_| "歌曲导播 ID 无效")?;
    Ok(root(app)?.join(id.to_string()))
}
fn read(path: &Path) -> Result<Director, String> {
    serde_json::from_slice(&fs::read(path.join("director.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn write(path: &Path, song: &Director) -> Result<(), String> {
    crate::queue_store::atomic_write(path, "director.json", &serde_json::to_string_pretty(song).map_err(|e| e.to_string())?)
}
fn public(path: &Path, song: &Director) -> Value {
    let mut value = serde_json::to_value(song).unwrap();
    value["audio_path"] = json!(path.join(&song.audio_file).to_string_lossy());
    value["directory"] = json!(path.to_string_lossy());
    value["available"] = json!(path.join(&song.audio_file).is_file());
    match crate::song_pcm::load(path,&path.join(&song.audio_file),&song.cues) {
        Ok(cache)=>{value["pcm_ready"]=json!(true);value["pcm_segments"]=cache.segments(path).unwrap_or(json!([]));},
        Err(error)=>{value["pcm_ready"]=json!(false);value["pcm_error"]=json!(error);value["pcm_segments"]=json!([]);},
    }
    value
}
fn timestamp(ms: u64) -> String { format!("{:02}:{:02}:{:02},{:03}", ms / 3600000, ms / 60000 % 60, ms / 1000 % 60, ms % 1000) }
fn srt(cues: &[Cue]) -> String {
    cues.iter().enumerate().map(|(i,c)| format!("{}\n{} --> {}\n{}\n\n", i+1, timestamp(c.start_ms), timestamp(c.end_ms), c.text.trim())).collect()
}
fn validate(cues: &[Cue], duration: u64) -> Result<(), String> {
    if cues.is_empty() || cues.len() > 2000 { return Err("歌词时间轴需包含 1～2000 段歌词".into()); }
    let mut last = 0;
    for cue in cues {
        if cue.start_ms < last || cue.start_ms >= cue.end_ms || cue.end_ms > duration || cue.lead_ms > 5000
            || cue.text.trim().is_empty() || cue.text.chars().count() > 300 || cue.text.chars().any(|c| c.is_control() && c != '\n') {
            return Err("歌词时间轴无效：需按时间排序、位于歌曲时长内，每段 1～300 字，提前量为 0～5000 毫秒".into());
        }
        last = cue.start_ms;
    }
    Ok(())
}
fn save_timeline(path: &Path, song: &mut Director, cues: Vec<Cue>) -> Result<(), String> {
    validate(&cues, song.duration_ms)?;
    crate::queue_store::atomic_write(path, "corrected.srt", &srt(&cues))?;
    let timeline: Vec<Value> = cues.iter().map(|c| json!({"start_ms":c.start_ms,"end_ms":c.end_ms,"text":c.text,"lead_ms":c.lead_ms,"send_at_ms":c.start_ms.saturating_sub(c.lead_ms)})).collect();
    crate::queue_store::atomic_write(path, "timeline.json", &serde_json::to_string_pretty(&timeline).map_err(|e| e.to_string())?)?;
    song.cues = cues; song.status = "ready".into(); song.error = None; write(path, song)
}

#[tauri::command]
pub fn director_list(app: tauri::AppHandle) -> Result<Value, String> {
    let directory = root(&app)?;
    let mut songs = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.path().is_dir() { continue; }
        let song = read(&entry.path())?;
        songs.push(public(&entry.path(), &song));
    }
    songs.sort_by_key(|v| std::cmp::Reverse(v["created_at"].as_u64().unwrap_or(0)));
    Ok(json!({"songs":songs,"directory":directory.to_string_lossy()}))
}
#[tauri::command]
pub fn director_get(app: tauri::AppHandle, id: String) -> Result<Value, String> {
    let path = folder(&app, &id)?; Ok(public(&path, &read(&path)?))
}
#[tauri::command]
pub async fn director_create(app: tauri::AppHandle, request: CreateRequest, tts: crate::component::TtsConfig) -> Result<Value, String> {
    if request.title.trim().is_empty() || request.title.chars().count() > 100 || request.lyrics.trim().is_empty() || request.lyrics.len() > 100000
        || !(1000..=1800000).contains(&request.duration_ms) { return Err("请填写歌名、完整歌词，并上传 1 秒～30 分钟的歌曲".into()); }
    let (prefix, data) = request.audio_data.split_once(",").ok_or("歌曲音频格式无效")?;
    let ext = match prefix { "data:audio/mpeg;base64" => "mp3", "data:audio/wav;base64" => "wav", "data:audio/aac;base64" => "aac", "data:audio/mp4;base64" => "m4a", _ => return Err("请上传 MP3、WAV、AAC 或 M4A".into()) };
    if data.len() > 140 * 1024 * 1024 { return Err("歌曲文件需小于 100 MB".into()); }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "歌曲 Base64 编码无效")?;
    if bytes.is_empty() || bytes.len() >= 100 * 1024 * 1024 { return Err("歌曲文件不能为空且需小于 100 MB".into()); }
    let mut song = Director { id: uuid::Uuid::new_v4().to_string(), title: request.title.trim().into(), created_at: crate::unix_ms(), duration_ms: request.duration_ms,
        audio_name: request.audio_name, audio_file: format!("audio.{ext}"), lyrics: request.lyrics, status: "transcribing".into(), raw_segments: vec![], cues: vec![], error: None, pcm_lead_ms:0 };
    let path = folder(&app, &song.id)?; fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let _job = DirectorJob::acquire(&app, &song.id)?;
    fs::write(path.join(&song.audio_file), bytes).map_err(|e| e.to_string())?;
    fs::write(path.join("lyrics.txt"), &song.lyrics).map_err(|e| e.to_string())?;
    write(&path, &song)?;
    transcribe(&tts, &path, &mut song).await?;
    Ok(public(&path, &song))
}
async fn transcribe(tts: &crate::component::TtsConfig, path: &Path, song: &mut Director) -> Result<(), String> {
    song.status = "transcribing".into(); song.error = None; write(path, song)?;
    let result = crate::speech_stt::transcribe_file(tts, &path.join(&song.audio_file)).await;
    let outcome = result.and_then(|value| {
        // Save the untouched ASR API response and millisecond sentence timestamps.
        crate::queue_store::atomic_write(path, "funasr.json", &serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?)?;
        let segments = value["segments"].as_array().ok_or("语音识别未返回字幕")?;
        song.raw_segments = segments.iter().map(|c| Ok(Cue { start_ms:c["start_ms"].as_u64().ok_or("字幕时间无效")?, end_ms:c["end_ms"].as_u64().ok_or("字幕时间无效")?, text:c["text"].as_str().ok_or("字幕内容无效")?.into(), lead_ms:500 })).collect::<Result<_, String>>()?;
        // raw.srt is only FunASR's result; correction never overwrites it.
        crate::queue_store::atomic_write(path, "raw.srt", &srt(&song.raw_segments))?;
        if song.raw_segments.is_empty() { return Err("未识别出歌词，请检查音频后重试".into()); }
        Ok(())
    });
    song.status = if outcome.is_ok() { "draft" } else { "failed" }.into();
    song.error = outcome.as_ref().err().cloned(); write(path, song)?; outcome
}
#[tauri::command]
pub async fn director_transcribe(app: tauri::AppHandle, id: String, tts: crate::component::TtsConfig) -> Result<Value, String> {
    let _job = DirectorJob::acquire(&app, &id)?;
    crate::queue_store::ensure_song_not_queued(&app, &id)?;
    let path = folder(&app, &id)?; let mut song = read(&path)?;
    transcribe(&tts, &path, &mut song).await?; Ok(public(&path, &song))
}
#[tauri::command]
pub async fn director_correct(app: tauri::AppHandle, id: String, base_url: String, key: String, model: String) -> Result<Value, String> {
    let _job = DirectorJob::acquire(&app, &id)?;
    crate::queue_store::ensure_song_not_queued(&app, &id)?;
    let path = folder(&app, &id)?; let mut song = read(&path)?;
    if song.raw_segments.is_empty() { return Err("请先完成语音识别".into()); }
    let cues = crate::model_api::correct_song_lyrics(base_url, key, model, &song.lyrics, &song.raw_segments).await?;
    save_timeline(&path, &mut song, cues)?; prepare_pcm(&app,&path,&song).await?; Ok(public(&path, &song))
}
#[tauri::command]
pub async fn director_save(app: tauri::AppHandle, id: String, cues: Vec<Cue>, pcm_lead_ms:Option<u64>) -> Result<Value, String> {
    let _job = DirectorJob::acquire(&app, &id)?;
    crate::queue_store::ensure_song_not_queued(&app, &id)?;
    let path = folder(&app, &id)?; let mut song = read(&path)?;
    if let Some(lead)=pcm_lead_ms {if lead>5000{return Err("PCM提前量需为0–5000毫秒".into());}song.pcm_lead_ms=lead;}
    save_timeline(&path, &mut song, cues)?; prepare_pcm(&app,&path,&song).await?; Ok(public(&path, &song))
}
async fn prepare_pcm(app:&tauri::AppHandle,path:&Path,song:&Director)->Result<(),String> {
    validate(&song.cues,song.duration_ms)?;
    let app=app.clone();let path=path.to_path_buf();let song=song.clone();
    tauri::async_runtime::spawn_blocking(move||crate::song_pcm::build(&path,&path.join(&song.audio_file),&song.cues,|src,dst|crate::speech_runtime::decode_song_audio(&app,src,dst)).map(|_|())).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn director_prepare_pcm(app:tauri::AppHandle,id:String)->Result<Value,String> {
    let _job=DirectorJob::acquire(&app,&id)?;crate::queue_store::ensure_song_not_queued(&app,&id)?;
    let path=folder(&app,&id)?;let song=read(&path)?;prepare_pcm(&app,&path,&song).await?;Ok(public(&path,&song))
}
#[tauri::command]
pub fn director_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let _job = DirectorJob::acquire(&app, &id)?;
    crate::queue_store::ensure_song_not_queued(&app, &id)?;
    let path = folder(&app, &id)?;
    // The UUID directory is always an immediate child of the owned song root.
    if path.is_dir() { fs::remove_dir_all(path).map_err(|e| e.to_string())?; } Ok(())
}
#[tauri::command]
pub fn director_open_folder(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    let path = if let Some(id) = id { folder(&app, &id)? } else { root(&app)? };
    #[cfg(windows)] { std::process::Command::new("explorer.exe").arg(path).spawn().map_err(|e| e.to_string())?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn srt_and_timeline_bounds() {
        let mut cues = vec![Cue { start_ms:1234, end_ms:2500, text:"歌词".into(), lead_ms:500 }];
        assert_eq!(srt(&cues), "1\n00:00:01,234 --> 00:00:02,500\n歌词\n\n");
        assert!(validate(&cues, 3000).is_ok());
        cues[0].end_ms = 3001; assert!(validate(&cues, 3000).is_err());
        cues[0].end_ms = 2500; cues[0].lead_ms = 5001; assert!(validate(&cues, 3000).is_err());
    }

    #[test]
    fn timeline_save_preserves_raw_srt_and_records_per_cue_dispatch_time() {
        let path = std::env::temp_dir().join(format!("director-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("raw.srt"), "original whisper").unwrap();
        let mut song = Director { id:uuid::Uuid::new_v4().to_string(), title:"测试".into(), created_at:1, duration_ms:3000, audio_name:"song.mp3".into(), audio_file:"audio.mp3".into(), lyrics:"参考歌词".into(), status:"draft".into(), raw_segments:vec![], cues:vec![], error:None, pcm_lead_ms:0 };
        let cues = vec![Cue { start_ms:100, end_ms:400, text:"开头".into(), lead_ms:500 }, Cue { start_ms:1000, end_ms:2000, text:"校正歌词".into(), lead_ms:600 }];
        save_timeline(&path, &mut song, cues).unwrap();
        assert_eq!(fs::read_to_string(path.join("raw.srt")).unwrap(), "original whisper");
        let timeline: Value = serde_json::from_slice(&fs::read(path.join("timeline.json")).unwrap()).unwrap();
        assert_eq!(timeline[0]["send_at_ms"], 0); assert_eq!(timeline[1]["send_at_ms"], 400);
        assert_eq!(read(&path).unwrap().status, "ready");
        assert!(fs::read_to_string(path.join("corrected.srt")).unwrap().contains("校正歌词"));
        // Failed edits leave the last valid, playable timeline intact.
        assert!(save_timeline(&path, &mut song, vec![]).is_err());
        assert_eq!(read(&path).unwrap().cues.len(), 2);
        fs::remove_dir_all(path).unwrap();
    }
}
