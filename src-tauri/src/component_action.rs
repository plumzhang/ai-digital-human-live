use crate::{Outbound, Session};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::sync::{oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

type WriteReceipt = oneshot::Receiver<Result<(), String>>;

#[derive(serde::Deserialize)]
pub struct SlotActions {
    playback_token: String,
    #[serde(default)]
    started_at: Option<u64>,
    #[serde(default)]
    send_delay_ms: u64,
    #[serde(default)]
    play_delay_ms: u64,
    #[serde(default)]
    reply_delay_ms: u64,
    #[serde(default)]
    handoff_delay_ms: u64,
    handoff: Option<SlotHandoff>,
    reply: Option<SlotReply>,
}
#[derive(serde::Deserialize)]
struct SlotHandoff {
    direction: String,
    angle_deg: u16,
}
#[derive(serde::Deserialize)]
struct SlotReply {
    gesture: Option<String>,
    instruction: Option<String>,
}
pub(crate) struct PreparedSlotActions {
    pub playback_token: String,
    pub started_at: u64,
    pub send_delay_ms: u64,
    pub play_delay_ms: u64,
    pub reply_delay_ms: u64,
    pub handoff_delay_ms: u64,
    pub handoff: Option<Value>,
    pub reply: Option<Value>,
}
impl SlotActions {
    pub(crate) fn prepare(self, task_id: &str) -> Result<PreparedSlotActions, String> {
        if uuid::Uuid::parse_str(&self.playback_token).is_err() || self.reply_delay_ms > 60_000 {
            return Err("槽位播放标识或回复动作延迟无效（需0–60000毫秒）".into());
        }
        if self.handoff_delay_ms > 60_000 {
            return Err("承接动作延迟无效（需0–60000毫秒）".into());
        }
        if self.send_delay_ms > 10_000 || self.play_delay_ms > 10_000 {
            return Err("PCM发送和本地播放延迟需为0–10000毫秒".into());
        }
        let now = crate::unix_ms() as u64;
        let started_at = self.started_at.unwrap_or(now);
        if started_at > now + 1000 || now.saturating_sub(started_at) > 120_000 {
            return Err("槽位开始时间已失效".into());
        }
        Ok(PreparedSlotActions {
            playback_token: self.playback_token,
            started_at,
            send_delay_ms: self.send_delay_ms,
            play_delay_ms: self.play_delay_ms,
            reply_delay_ms: self.reply_delay_ms,
            handoff_delay_ms: self.handoff_delay_ms,
            handoff: self
                .handoff
                .map(|h| crate::handoff_action_payload(task_id, &h.direction, h.angle_deg))
                .transpose()?,
            reply: self
                .reply
                .map(|r| {
                    crate::avatar_action_payload(
                        task_id,
                        r.gesture.as_deref(),
                        r.instruction.as_deref(),
                    )
                })
                .transpose()?,
        })
    }
}

pub(crate) fn report(
    app: &tauri::AppHandle,
    live: &str,
    task: &str,
    token: &str,
    kind: &str,
    state: &str,
    error: Option<&str>,
) {
    let _=app.emit("component-slot-action",json!({"live_id":live,"task_id":task,"playback_token":token,"kind":kind,"state":state,"error":error}));
}

// Both actions share the audio generation. No detached timer can outlive it.
pub(crate) async fn submit(
    app: &tauri::AppHandle,
    live: &str,
    task: &str,
    epoch: u64,
    token: &str,
    kind: &str,
    payload: Value,
) {
    report(app, live, task, token, kind, "pending", None);
    let receipts = {
        let state = app.state::<crate::AppState>();
        state
            .session
            .lock()
            .map_err(|e| e.to_string())
            .and_then(|mut guard| {
                let session = guard
                    .as_mut()
                    .filter(|s| {
                        s.live_id == live
                            && s.ready
                            && s.speaking
                            && *s.speech_cancel.borrow() == epoch
                    })
                    .ok_or("原槽位已取消，动作未发送".to_string())?;
                enqueue(session, payload)
            })
    };
    let result = match receipts {
        Ok(receipts) => wait(receipts).await,
        Err(error) => Err(error),
    };
    report(
        app,
        live,
        task,
        token,
        kind,
        if result.is_ok() {
            "submitted"
        } else {
            "failed"
        },
        result.as_ref().err().map(String::as_str),
    );
}

pub(crate) async fn action_due(
    delay_ms: u64,
    slot_started: tokio::time::Instant,
    mut finished: watch::Receiver<bool>,
) -> bool {
    if *finished.borrow() {
        return false;
    }
    tokio::select! {biased;
        _=finished.changed()=>false,
        _=tokio::time::sleep_until(slot_started+std::time::Duration::from_millis(delay_ms))=>!*finished.borrow(),
    }
}

/// Called under the session lock, so both frames keep their sequence/queue order.
/// Type 97 configures the low-level motion prompt; type 9 drives the action.
pub(crate) fn enqueue(session: &mut Session, payload: Value) -> Result<[WriteReceipt; 2], String> {
    if !session.ready {
        return Err("组件会话尚未就绪，动作未发送".into());
    }
    let action = &payload["text_action"];
    let description = action["content"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("动作描述不能为空")?;
    let msg_id = action["msg_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("动作缺少任务标识")?;
    let (prompt_written, prompt_receipt) = oneshot::channel();
    let (trigger_written, trigger_receipt) = oneshot::channel();
    for (kind, data, written) in [
        (
            97,
            json!({"session_update":{"action_description":description}}),
            prompt_written,
        ),
        (
            9,
            json!({"text_msg":{"msg_id":msg_id,"content":description,"timestamp":crate::unix_ms()}}),
            trigger_written,
        ),
    ] {
        session.seq += 1;
        let signal = json!({"type":kind,"live_id":session.live_id,"conn_id":session.conn_id,"seq_id":session.seq,"payload":data});
        session
            .sender
            .send(Outbound {
                message: Message::Text(signal.to_string().into()),
                written: Some(written),
                epoch: Some((
                    session.speech_cancel.subscribe(),
                    *session.speech_cancel.borrow(),
                )),
            })
            .map_err(|_| "控制连接已关闭，动作未完整发送")?;
    }
    Ok([prompt_receipt, trigger_receipt])
}

pub(crate) async fn wait(receipts: [WriteReceipt; 2]) -> Result<(), String> {
    tokio::time::timeout(std::time::Duration::from_secs(4), async {
        for receipt in receipts {
            receipt.await.map_err(|_| "动作写入未确认")??;
        }
        Ok(())
    })
    .await
    .map_err(|_| "动作发送超时，请检查数字人连接")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session() -> (Session, tokio::sync::mpsc::UnboundedReceiver<Outbound>) {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        (
            Session {
                live_id: "test-live".into(),
                conn_id: "conn".into(),
                key: "not-sent".into(),
                region: "cn".into(),
                rtc: Value::Null,
                sender,
                seq: 100,
                last_video_frame_ms: 0,
                voice_provider: "omnivoice".into(),
                ready: true,
                speaking: false,
                external_audio: None, song_audio: None, reply_task: None,
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
            },
            receiver,
        )
    }
    #[tokio::test]
    async fn slot_actions_write_prompt_and_driver_with_the_same_task_identity_in_order() {
        for payload in [
            crate::avatar_action_payload("slot-1", None, Some("拿起口红轻涂双唇")).unwrap(),
            crate::gift_action_payload("slot-1", "heart").unwrap(),
            crate::handoff_action_payload("slot-1", "left_down", 30).unwrap(),
        ] {
            let (mut session, mut receiver) = session();
            let receipts = enqueue(&mut session, payload).unwrap();
            let first = receiver.try_recv().unwrap();
            let second = receiver.try_recv().unwrap();
            let a: Value = serde_json::from_str(first.message.to_text().unwrap()).unwrap();
            let b: Value = serde_json::from_str(second.message.to_text().unwrap()).unwrap();
            assert_eq!(a["type"], 97);
            assert_eq!(b["type"], 9);
            assert_eq!(a["seq_id"], 101);
            assert_eq!(b["seq_id"], 102);
            assert_eq!(
                a["payload"]["session_update"]["action_description"],
                b["payload"]["text_msg"]["content"]
            );
            assert!(b["payload"]["text_msg"]["msg_id"]
                .as_str()
                .unwrap()
                .ends_with("slot-1"));
            assert!(!a.to_string().contains("not-sent"));
            first.written.unwrap().send(Ok(())).unwrap();
            second.written.unwrap().send(Ok(())).unwrap();
            wait(receipts).await.unwrap();
            assert!(receiver.try_recv().is_err());
        }
    }
    #[tokio::test]
    async fn enqueue_is_not_reported_as_written_and_a_failed_driver_is_propagated() {
        let (mut session, mut receiver) = session();
        let receipts = enqueue(
            &mut session,
            crate::gift_action_payload("slot", "heart").unwrap(),
        )
        .unwrap();
        let first = receiver.try_recv().unwrap();
        let second = receiver.try_recv().unwrap();
        first.written.unwrap().send(Ok(())).unwrap();
        let pending = wait(receipts);
        tokio::pin!(pending);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut pending)
                .await
                .is_err()
        );
        session.speech_cancel.send_modify(|epoch| *epoch += 1);
        let (watch, epoch) = second.epoch.unwrap();
        assert_ne!(*watch.borrow(), epoch);
        second
            .written
            .unwrap()
            .send(Err("动作已取消".into()))
            .unwrap();
        assert_eq!(pending.await.unwrap_err(), "动作已取消");
    }
    #[test]
    fn unready_sessions_do_not_enqueue_any_action() {
        let (mut session, mut receiver) = session();
        session.ready = false;
        assert!(enqueue(
            &mut session,
            crate::gift_action_payload("slot", "heart").unwrap()
        )
        .is_err());
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn zero_and_500ms_delays_use_the_slot_start_without_waiting_for_pcm() {
        for delay in [0, 500] {
            let (_finished, watch) = watch::channel(false);
            let start = tokio::time::Instant::now();
            let scheduled = action_due(delay, start, watch);
            tokio::pin!(scheduled);
            if delay > 0 {
                assert!(tokio::time::timeout(
                    std::time::Duration::from_millis(450),
                    &mut scheduled
                )
                .await
                .is_err());
            }
            assert!(
                tokio::time::timeout(std::time::Duration::from_secs(2), &mut scheduled)
                    .await
                    .unwrap()
            );
            assert!(start.elapsed() >= std::time::Duration::from_millis(delay));
        }
    }

    #[tokio::test]
    async fn pending_reply_is_cancelled_when_slot_audio_ends() {
        let (finished, watch) = watch::channel(false);
        let scheduled = action_due(500, tokio::time::Instant::now(), watch);
        tokio::pin!(scheduled);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut scheduled)
                .await
                .is_err()
        );
        finished.send_replace(true);
        assert!(!scheduled.await);
        let (_finished, watch) = watch::channel(true);
        assert!(!action_due(0, tokio::time::Instant::now(), watch).await);
    }

    #[tokio::test]
    async fn command_setup_time_does_not_restart_the_reply_delay() {
        let (_finished, watch) = watch::channel(false);
        let slot_started = tokio::time::Instant::now() - std::time::Duration::from_millis(400);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(300), action_due(500, slot_started, watch)).await.unwrap());
    }

    #[tokio::test]
    async fn handoff_and_reply_use_independent_delays_and_share_cancellation() {
        let origin = tokio::time::Instant::now();
        let (finished, watch) = watch::channel(false);
        let handoff = action_due(100, origin, watch.clone());
        let reply = action_due(250, origin, watch.clone());
        let (handoff_due, reply_due) = tokio::time::timeout(std::time::Duration::from_millis(340), async {
            tokio::join!(handoff, reply)
        }).await.unwrap();
        assert!(handoff_due && reply_due);
        let pending = async { tokio::join!(action_due(500, origin, watch.clone()), action_due(600, origin, watch)) };
        tokio::pin!(pending);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(20), &mut pending).await.is_err());
        finished.send_replace(true);
        assert_eq!(pending.await, (false, false));
    }

    #[test]
    fn slot_plan_binds_both_actions_to_the_new_slot_and_validates_delay_before_playback() {
        let started_at = crate::unix_ms() as u64 - 100;
        let input = json!({"playback_token":uuid::Uuid::new_v4().to_string(),"started_at":started_at,
            "send_delay_ms":500,"play_delay_ms":800,"reply_delay_ms":500,"handoff_delay_ms":300,
            "handoff":{"direction":"right_down","angle_deg":35},"reply":{"instruction":"涂一下口红"}});
        let plan = serde_json::from_value::<SlotActions>(input.clone())
            .unwrap()
            .prepare("next-slot")
            .unwrap();
        assert_eq!(plan.reply_delay_ms, 500);
        assert_eq!(plan.handoff_delay_ms, 300);
        assert_eq!(plan.started_at, started_at);
        assert_eq!(plan.send_delay_ms, 500);
        assert_eq!(plan.play_delay_ms, 800);
        assert_eq!(
            plan.handoff.unwrap()["text_action"]["msg_id"],
            "handoff-next-slot"
        );
        assert_eq!(
            plan.reply.unwrap()["text_action"]["msg_id"],
            "avatar-action-next-slot"
        );
        for field in ["send_delay_ms", "play_delay_ms"] {
            let mut invalid = input.clone(); invalid[field] = json!(10001);
            assert!(serde_json::from_value::<SlotActions>(invalid).unwrap().prepare("next-slot").is_err());
        }
        let mut invalid_handoff = input.clone(); invalid_handoff["handoff_delay_ms"] = json!(60001);
        assert!(serde_json::from_value::<SlotActions>(invalid_handoff).unwrap().prepare("next-slot").is_err());
        let mut invalid = input;
        invalid["reply_delay_ms"] = json!(60001);
        assert!(serde_json::from_value::<SlotActions>(invalid)
            .unwrap()
            .prepare("next-slot")
            .is_err());
    }
}
