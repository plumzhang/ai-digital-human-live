use crate::{
    component::{self, TtsConfig},
    speech_text::split_sentence,
    AppState,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, State};
use tokio::sync::watch;

pub(crate) struct PreparedAudio {
    live_id: String,
    task_id: String,
    text: String,
    tts: TtsConfig,
    voice_stamp: Option<(u64, std::time::SystemTime)>,
    pub parts: Vec<(String, Vec<u8>)>,
}
impl PreparedAudio {
    fn bytes(&self) -> usize {
        self.parts.iter().map(|(_, pcm)| pcm.len()).sum()
    }
}
pub(crate) async fn feed(
    audio: Arc<PreparedAudio>,
    sender: tokio::sync::mpsc::Sender<(String, Vec<u8>)>,
) -> Result<(), String> {
    for (text, pcm) in &audio.parts {
        sender
            .send((text.clone(), pcm.clone()))
            .await
            .map_err(|_| "播报已取消")?;
    }
    Ok(())
}
struct Active {
    token: String,
    cancel: watch::Sender<bool>,
}
#[derive(Default)]
struct Store {
    owner: String,
    live_id: String,
    allowed: HashSet<String>,
    entries: HashMap<String, Arc<PreparedAudio>>,
    active: Option<Active>,
}
#[derive(Default)]
pub struct PreparedSpeech(Mutex<Store>);
impl PreparedSpeech {
    pub(crate) fn preempt(&self) {
        if let Ok(store) = self.0.lock() {
            if let Some(active) = &store.active {
                active.cancel.send_modify(|c| *c = true);
            }
        }
    }
    fn open(&self) -> Result<String, String> {
        let mut store = self.0.lock().map_err(|e| e.to_string())?;
        if let Some(active) = &store.active {
            active.cancel.send_modify(|c| *c = true);
        }
        store.entries.clear();
        store.allowed.clear();
        store.live_id.clear();
        store.owner = uuid::Uuid::new_v4().to_string();
        Ok(store.owner.clone())
    }
    fn retain(
        &self,
        owner: Option<&str>,
        live_id: String,
        tokens: Vec<String>,
    ) -> Result<(), String> {
        if tokens.len() > 6 || tokens.iter().any(|t| uuid::Uuid::parse_str(t).is_err()) {
            return Err("预生成音频最多保留6个有效槽位".into());
        }
        let mut store = self.0.lock().map_err(|e| e.to_string())?;
        // A disposed/reloaded webview may finish an old cleanup after the new
        // queue has opened. It must not clear the new queue's PCM buffers.
        if owner.is_some_and(|owner| owner != store.owner) {
            return Ok(());
        }
        if store.live_id != live_id {
            store.entries.clear();
        }
        store.live_id = live_id;
        store.allowed = tokens.into_iter().collect();
        if let Some(active) = &store.active {
            if !store.allowed.contains(&active.token) {
                active.cancel.send_modify(|c| *c = true);
            }
        }
        let allowed = store.allowed.clone();
        store.entries.retain(|token, _| allowed.contains(token));
        Ok(())
    }
    fn take(
        &self,
        token: &str,
        live_id: &str,
        task_id: &str,
        text: &str,
        tts: &TtsConfig,
    ) -> Result<Arc<PreparedAudio>, String> {
        let mut store = self.0.lock().map_err(|e| e.to_string())?;
        let entry = store
            .entries
            .get(token)
            .ok_or("PCM缓存已失效，请重新准备该槽位")?;
        if entry.live_id != live_id
            || entry.task_id != task_id
            || entry.text != text
            || &entry.tts != tts
            || entry.voice_stamp != voice_stamp(tts)
        {
            return Err("会话、台词或音色已变化，请重新准备音频".into());
        }
        // A handle can be played once. A retry cannot accidentally replay cached audio.
        Ok(store.entries.remove(token).unwrap())
    }
}
fn voice_stamp(tts: &TtsConfig) -> Option<(u64, std::time::SystemTime)> {
    let path = tts.ref_audio.trim_matches(|c: char| {
        c.is_whitespace() || matches!(c,'"'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')
    });
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}
fn valid_session(app: &tauri::AppHandle, live_id: &str) -> bool {
    app.state::<AppState>()
        .session
        .lock()
        .ok()
        .is_some_and(|g| g.as_ref().is_some_and(|s| s.live_id == live_id && s.ready))
}
struct JobGuard {
    app: tauri::AppHandle,
    token: String,
    tts: TtsConfig,
    request_id: String,
}
impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Ok(mut store) = self.app.state::<PreparedSpeech>().0.lock() {
            if store.active.as_ref().is_some_and(|a| a.token == self.token) {
                store.active.take();
            }
        }
        let tts = self.tts.clone();
        let id = self.request_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(url) = component::endpoint(&tts.base_url, "api/tts/cancel") {
                if let Ok(client) = reqwest::Client::builder()
                    .timeout(Duration::from_secs(3))
                    .build()
                {
                    let _ = client
                        .post(url)
                        .bearer_auth(&tts.key)
                        .json(&json!({"request_id":id}))
                        .send()
                        .await;
                }
            }
        });
    }
}

pub(crate) async fn prepare_parts(
    tts: &TtsConfig,
    text: &str,
    request_id: &str,
) -> Result<Vec<(String, Vec<u8>)>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut buffer = text.to_owned();
    let mut parts = Vec::new();
    let mut bytes = 0;
    while let Some(sentence) = split_sentence(&mut buffer, true) {
        if sentence.is_empty() {
            continue;
        }
        let pcm = component::synthesize_sentence(&client, tts, request_id, &sentence).await?;
        bytes += pcm.len();
        if bytes > 48000 * 60 {
            return Err("单条预生成语音超过60秒，已停止合成".into());
        }
        parts.push((sentence, pcm));
    }
    Ok::<_, String>(parts)
}

#[tauri::command]
pub fn component_audio_open(runtime: State<'_, PreparedSpeech>) -> Result<String, String> {
    runtime.open()
}

#[tauri::command]
pub fn component_audio_retain(
    runtime: State<'_, PreparedSpeech>,
    owner: String,
    live_id: String,
    tokens: Vec<String>,
) -> Result<(), String> {
    runtime.retain(Some(&owner), live_id, tokens)
}

#[tauri::command]
pub async fn component_prepare_audio(
    app: tauri::AppHandle,
    live_id: String,
    task_id: String,
    token: String,
    text: String,
    tts: TtsConfig,
) -> Result<Value, String> {
    if !valid_session(&app, &live_id) {
        return Ok(json!({"state":"cancelled"}));
    }
    if text.trim().is_empty() || text.chars().count() > 2000 {
        return Err("预合成台词需为1到2000字".into());
    }
    let runtime = app.state::<PreparedSpeech>();
    // Do not queue ahead of a foreground synthesis. Retry on the next queue tick.
    let Ok(_inference) = component::TTS_GATE.try_lock() else {
        return Ok(json!({"state":"busy"}));
    };
    let (cancel, mut cancelled) = watch::channel(false);
    {
        let mut store = runtime.0.lock().map_err(|e| e.to_string())?;
        if store.live_id != live_id || !store.allowed.contains(&token) {
            return Ok(json!({"state":"cancelled"}));
        }
        if store.active.is_some() {
            return Ok(json!({"state":"busy"}));
        }
        store.active = Some(Active {
            token: token.clone(),
            cancel,
        });
    }
    let request_id = format!("prepare-{}", uuid::Uuid::new_v4());
    let _job = JobGuard {
        app: app.clone(),
        token: token.clone(),
        tts: tts.clone(),
        request_id: request_id.clone(),
    };
    let stamp = voice_stamp(&tts);
    let synthesize = prepare_parts(&tts, &text, &request_id);
    let parts = tokio::select! { biased; _=cancelled.changed()=>return Ok(json!({"state":"cancelled"})), result=synthesize=>result? };
    if !valid_session(&app, &live_id) {
        return Ok(json!({"state":"cancelled"}));
    }
    let audio = Arc::new(PreparedAudio {
        live_id: live_id.clone(),
        task_id,
        text,
        tts,
        voice_stamp: stamp,
        parts,
    });
    let duration_ms = audio.bytes() / 48;
    {
        let mut store = runtime.0.lock().map_err(|e| e.to_string())?;
        if *cancelled.borrow() || store.live_id != live_id || !store.allowed.contains(&token) {
            return Ok(json!({"state":"cancelled"}));
        }
        if store.entries.values().map(|a| a.bytes()).sum::<usize>() + audio.bytes()
            > 24 * 1024 * 1024
        {
            return Err("预生成PCM缓存超过24MB上限".into());
        }
        store.entries.insert(token.clone(), audio);
    }
    Ok(json!({"state":"ready","token":token,"duration_ms":duration_ms}))
}

#[tauri::command]
pub async fn component_play_prepared(
    app: tauri::AppHandle,
    live_id: String,
    task_id: String,
    token: String,
    text: String,
    tts: TtsConfig,
) -> Result<(), String> {
    if !valid_session(&app, &live_id) {
        return Err("原会话已结束，缓存音频未发送".into());
    }
    let prepared = app
        .state::<PreparedSpeech>()
        .take(&token, &live_id, &task_id, &text, &tts)?;
    component::run_audio(app, live_id, text, task_id, false, Some(prepared)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tts() -> TtsConfig {
        TtsConfig {
            base_url: "http://local".into(),
            key: String::new(),
            model: "OmniVoice".into(),
            ref_audio: "missing.wav".into(),
            ref_text: "原话".into(),
        }
    }
    fn entry() -> Arc<PreparedAudio> {
        Arc::new(PreparedAudio {
            live_id: "live".into(),
            task_id: "slot".into(),
            text: "你好。".into(),
            tts: tts(),
            voice_stamp: None,
            parts: vec![("你好。".into(), vec![1, 0, 2, 0])],
        })
    }
    #[test]
    fn pcm_is_bound_to_slot_text_voice_and_session_and_can_only_be_taken_once() {
        let runtime = PreparedSpeech::default();
        let token = uuid::Uuid::new_v4().to_string();
        runtime
            .retain(None, "live".into(), vec![token.clone()])
            .unwrap();
        runtime
            .0
            .lock()
            .unwrap()
            .entries
            .insert(token.clone(), entry());
        for (live, slot, text) in [
            ("other", "slot", "你好。"),
            ("live", "other", "你好。"),
            ("live", "slot", "再见。"),
        ] {
            assert!(runtime.take(&token, live, slot, text, &tts()).is_err());
        }
        let mut changed = tts();
        changed.ref_text = "别的原话".into();
        assert!(runtime
            .take(&token, "live", "slot", "你好。", &changed)
            .is_err());
        assert_eq!(
            runtime
                .take(&token, "live", "slot", "你好。", &tts())
                .unwrap()
                .bytes(),
            4
        );
        assert!(runtime
            .take(&token, "live", "slot", "你好。", &tts())
            .is_err());
    }
    #[test]
    fn skip_retry_and_live_changes_remove_pcm_and_cancel_inflight_work() {
        let runtime = PreparedSpeech::default();
        let token = uuid::Uuid::new_v4().to_string();
        runtime
            .retain(None, "live".into(), vec![token.clone()])
            .unwrap();
        let (cancel, watch) = watch::channel(false);
        {
            let mut store = runtime.0.lock().unwrap();
            store.entries.insert(token.clone(), entry());
            store.active = Some(Active { token, cancel });
        }
        runtime.retain(None, "new-live".into(), vec![]).unwrap();
        assert!(*watch.borrow());
        assert!(runtime.0.lock().unwrap().entries.is_empty());
        assert!(runtime
            .retain(
                None,
                "live".into(),
                (0..7).map(|_| uuid::Uuid::new_v4().to_string()).collect()
            )
            .is_err());
    }
    #[test]
    fn a_late_cleanup_from_the_previous_window_cannot_erase_new_pcm() {
        let runtime = PreparedSpeech::default();
        let old = runtime.open().unwrap();
        let new = runtime.open().unwrap();
        let token = uuid::Uuid::new_v4().to_string();
        runtime
            .retain(Some(&new), "live".into(), vec![token.clone()])
            .unwrap();
        runtime
            .0
            .lock()
            .unwrap()
            .entries
            .insert(token.clone(), entry());
        runtime.retain(Some(&old), "".into(), vec![]).unwrap();
        assert!(runtime
            .take(&token, "live", "slot", "你好。", &tts())
            .is_ok());
    }
    #[tokio::test]
    async fn playback_uses_only_cached_pcm_and_closes_the_audio_channel() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let (sent, parts) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(feed(entry(), tx), async {
                let mut out = Vec::new();
                while let Some(part) = rx.recv().await {
                    out.push(part);
                }
                out
            })
        })
        .await
        .unwrap();
        sent.unwrap();
        assert_eq!(parts, vec![("你好。".into(), vec![1, 0, 2, 0])]);
    }
    #[tokio::test]
    #[ignore = "reads a local TTS config from stdin and performs real PCM pre-synthesis/cache retrieval without Vidu"]
    async fn local_pcm_prefetch_cache() {
        use std::io::Read;
        let mut input = String::new();
        std::io::stdin().read_to_string(&mut input).unwrap();
        let tts: TtsConfig = serde_json::from_str(&input).expect("TTS config missing");
        let text = "我叫晚晚，是直播间陪你聊天的姐姐。";
        let _inference = component::TTS_GATE.lock().await;
        let begin = std::time::Instant::now();
        let parts = prepare_parts(&tts, text, &uuid::Uuid::new_v4().to_string())
            .await
            .unwrap();
        let prepare_ms = begin.elapsed().as_millis();
        let audio = Arc::new(PreparedAudio {
            live_id: "local-probe".into(),
            task_id: "slot-2".into(),
            text: text.into(),
            voice_stamp: voice_stamp(&tts),
            tts: tts.clone(),
            parts,
        });
        let bytes = audio.bytes();
        let runtime = PreparedSpeech::default();
        let token = uuid::Uuid::new_v4().to_string();
        runtime
            .retain(None, "local-probe".into(), vec![token.clone()])
            .unwrap();
        runtime
            .0
            .lock()
            .unwrap()
            .entries
            .insert(token.clone(), audio);
        let cached = runtime
            .take(&token, "local-probe", "slot-2", text, &tts)
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let start = std::time::Instant::now();
        let (_, pcm) = tokio::try_join!(feed(cached, tx), async {
            let mut all = Vec::new();
            while let Some((_, part)) = rx.recv().await {
                all.extend_from_slice(&part);
            }
            Ok::<_, String>(all)
        })
        .unwrap();
        assert_eq!(pcm.len(), bytes);
        if let Some(output) = std::env::var_os("SPEECH_PROBE_OUTPUT") {
            std::fs::write(output, crate::component::pcm_wav(&pcm)).unwrap();
        }
        println!(
            "{}",
            json!({"text":text,"prepare_ms":prepare_ms,"audio_seconds":bytes as f64/48000.0,"cached_feed_ms":start.elapsed().as_millis(),"pcm_bytes":bytes})
        );
    }
}
