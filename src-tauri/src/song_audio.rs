use crate::{queue_signal, AppState, Session};
use serde_json::json;
use tauri::{Emitter, State};

#[derive(Clone)]
pub(crate) struct SongAudioOwner {
    pub task_id: String,
    pub token: String,
    pub active: bool,
}

fn phase(session: &mut Session, token: &str, active: bool, sequence: u64) -> Result<bool, String> {
    let owner = session
        .song_audio
        .as_mut()
        .filter(|s| s.token == token)
        .ok_or("歌曲音频已取消，忽略旧片段")?;
    if owner.active == active {
        return Ok(false);
    }
    owner.active = active;
    if active {
        session.speech_cancel.send_modify(|value| *value += 1);
        session.reply_task = None;
        session.speaking = true;
        session.external_audio = Some((token.to_owned(), sequence));
        Ok(true)
    } else {
        // End only the song-owned phase. A later chat generation must survive
        // a delayed stop/cleanup from an older segment.
        if session
            .external_audio
            .as_ref()
            .is_some_and(|(id, _)| id == token)
        {
            session.speech_cancel.send_modify(|value| *value += 1);
            session.external_audio = None;
            session.speaking = false;
        }
        Ok(false)
    }
}
fn close(session: &mut Session, token: &str) -> Result<Option<bool>, String> {
    let Some(owner) = session.song_audio.as_ref().filter(|s| s.token == token) else {
        return Ok(None);
    };
    let active = owner.active;
    phase(session, token, false, 0)?;
    session.song_audio = None;
    Ok(Some(active))
}
fn interrupt_reply(session: &mut Session, task_id: &str) -> bool {
    if session.reply_task.as_deref() != Some(task_id) || session.external_audio.is_some() {
        return false;
    }
    session.speech_cancel.send_modify(|value| *value += 1);
    session.speaking = false;
    session.reply_task = None;
    true
}

#[tauri::command]
pub fn component_song_open(
    state: State<'_, AppState>,
    live_id: String,
    task_id: String,
    token: String,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&token).map_err(|_| "歌曲播放标识无效")?;
    if task_id.trim().is_empty() {
        return Err("歌曲槽位标识无效".into());
    }
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = guard
        .as_mut()
        .filter(|s| s.live_id == live_id && s.ready)
        .ok_or("组件会话尚未就绪")?;
    if let Some(owner) = session.song_audio.as_ref() {
        return if owner.token == token && owner.task_id == task_id {
            Ok(())
        } else {
            Err("上一首歌曲尚未释放".into())
        };
    }
    session.song_audio = Some(SongAudioOwner {
        task_id,
        token,
        active: false,
    });
    Ok(())
}

#[tauri::command]
pub fn component_song_phase(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    live_id: String,
    token: String,
    active: bool,
    sequence: u64,
) -> Result<(), String> {
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = guard
        .as_mut()
        .filter(|s| s.live_id == live_id && s.ready)
        .ok_or("组件会话尚未就绪")?;
    if phase(session, &token, active, sequence)? {
        queue_signal(&app, session, 7, json!({}), None)?;
    }
    let task_id = &session.song_audio.as_ref().unwrap().task_id;
    let _ = app.emit(
        "song-pcm-phase",
        json!({"live_id":live_id,"task_id":task_id,"playback_token":token,"active":active}),
    );
    Ok(())
}

#[tauri::command]
pub fn component_song_close(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    live_id: String,
    token: String,
) -> Result<(), String> {
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let Some(session) = guard.as_mut().filter(|s| s.live_id == live_id) else {
        return Ok(());
    };
    if close(session, &token)? == Some(true) {
        queue_signal(&app, session, 7, json!({}), None)?;
    }
    Ok(())
}

#[tauri::command]
pub fn component_interrupt_reply(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    live_id: String,
    task_id: String,
) -> Result<(), String> {
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let Some(session) = guard.as_mut().filter(|s| s.live_id == live_id) else {
        return Ok(());
    };
    if interrupt_reply(session, &task_id) {
        queue_signal(&app, session, 7, json!({}), None)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session() -> Session {
        Session {
            live_id: "live".into(),
            conn_id: "conn".into(),
            key: "local-test".into(),
            region: "cn".into(),
            rtc: serde_json::Value::Null,
            sender: tokio::sync::mpsc::unbounded_channel().0,
            seq: 0,
            last_video_frame_ms: 0,
            voice_provider: "omnivoice".into(),
            ready: true,
            speaking: false,
            external_audio: None,
            reply_task: None,
            song_audio: Some(SongAudioOwner {
                task_id: "parent".into(),
                token: "song-token".into(),
                active: false,
            }),
            conversation: Vec::new(),
            speech_cancel: tokio::sync::watch::channel(0).0,
            tts: crate::component::TtsConfig {
                base_url: "http://127.0.0.1:8766".into(),
                key: String::new(),
                model: "k2-fsa/OmniVoice".into(),
                ref_audio: String::new(),
                ref_text: String::new(),
            },
            llm: crate::component::LlmConfig {
                base_url: String::new(),
                key: String::new(),
                model: String::new(),
                persona: String::new(),
            },
            persona: String::new(),
        }
    }
    #[test]
    fn lyric_start_cancels_chat_epoch_before_claiming_the_pcm_channel() {
        let mut s = session();
        s.speaking = true;
        s.reply_task = Some("chat".into());
        let old = s.speech_cancel.subscribe();
        assert!(phase(&mut s, "song-token", true, 12).unwrap());
        assert!(old.has_changed().unwrap());
        assert!(s.song_audio.as_ref().unwrap().active);
        assert!(s.speaking);
        assert!(s.reply_task.is_none());
        assert_eq!(s.external_audio, Some(("song-token".into(), 12)));
        assert!(!phase(&mut s, "song-token", true, 0).unwrap());
        assert_eq!(s.external_audio.as_ref().unwrap().1, 12);
    }
    #[test]
    fn gap_releases_song_ownership_and_late_phase_stop_does_not_cancel_new_chat() {
        let mut s = session();
        phase(&mut s, "song-token", true, 0).unwrap();
        phase(&mut s, "song-token", false, 20).unwrap();
        assert!(!s.speaking);
        assert!(s.external_audio.is_none());
        s.speaking = true;
        s.reply_task = Some("new-chat".into());
        let epoch = *s.speech_cancel.borrow();
        assert_eq!(close(&mut s, "song-token").unwrap(), Some(false));
        assert_eq!(*s.speech_cancel.borrow(), epoch);
        assert!(s.speaking);
        assert_eq!(s.reply_task.as_deref(), Some("new-chat"));
    }
    #[test]
    fn old_tokens_and_scoped_chat_interrupt_cannot_stop_song_pcm() {
        let mut s = session();
        phase(&mut s, "song-token", true, 8).unwrap();
        let epoch = *s.speech_cancel.borrow();
        assert!(phase(&mut s, "old-song", false, 0).is_err());
        assert_eq!(close(&mut s, "old-song").unwrap(), None);
        assert!(!interrupt_reply(&mut s, "old-chat"));
        assert_eq!(*s.speech_cancel.borrow(), epoch);
        assert_eq!(s.external_audio.as_ref().unwrap().1, 8);
        assert_eq!(close(&mut s, "song-token").unwrap(), Some(true));
        assert!(!s.speaking);
        assert!(s.external_audio.is_none());
    }
}
