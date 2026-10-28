use crate::{Outbound, Session};
use serde_json::{json, Value};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

type WriteReceipt = oneshot::Receiver<Result<(), String>>;

/// Called under the session lock, so both frames keep their sequence/queue order.
/// Type 97 configures the low-level motion prompt; type 9 drives the action.
pub(crate) fn enqueue(session: &mut Session, payload: Value) -> Result<[WriteReceipt; 2], String> {
    if !session.ready { return Err("组件会话尚未就绪，动作未发送".into()); }
    let action = &payload["text_action"];
    let description = action["content"].as_str().filter(|s| !s.trim().is_empty()).ok_or("动作描述不能为空")?;
    let msg_id = action["msg_id"].as_str().filter(|s| !s.is_empty()).ok_or("动作缺少任务标识")?;
    let (prompt_written, prompt_receipt) = oneshot::channel();
    let (trigger_written, trigger_receipt) = oneshot::channel();
    for (kind, data, written) in [
        (97, json!({"session_update":{"action_description":description}}), prompt_written),
        (9, json!({"text_msg":{"msg_id":msg_id,"content":description,"timestamp":crate::unix_ms()}}), trigger_written),
    ] {
        session.seq += 1;
        let signal = json!({"type":kind,"live_id":session.live_id,"conn_id":session.conn_id,"seq_id":session.seq,"payload":data});
        session.sender.send(Outbound { message:Message::Text(signal.to_string().into()), written:Some(written),
            epoch:Some((session.speech_cancel.subscribe(), *session.speech_cancel.borrow())) })
            .map_err(|_| "控制连接已关闭，动作未完整发送")?;
    }
    Ok([prompt_receipt, trigger_receipt])
}

pub(crate) async fn wait(receipts: [WriteReceipt; 2]) -> Result<(), String> {
    tokio::time::timeout(std::time::Duration::from_secs(4), async {
        for receipt in receipts { receipt.await.map_err(|_| "动作写入未确认")??; }
        Ok(())
    }).await.map_err(|_| "动作发送超时，请检查数字人连接")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session() -> (Session, tokio::sync::mpsc::UnboundedReceiver<Outbound>) {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        (Session { live_id:"test-live".into(),conn_id:"conn".into(),key:"not-sent".into(),region:"cn".into(),rtc:Value::Null,
            sender,seq:100,last_video_frame_ms:0,voice_provider:"omnivoice".into(),ready:true,speaking:false,external_audio:None,
            conversation:Vec::new(),speech_cancel:tokio::sync::watch::channel(0).0,
            tts:crate::component::TtsConfig {base_url:"http://127.0.0.1:8766".into(),key:String::new(),model:"k2-fsa/OmniVoice".into(),ref_audio:String::new(),ref_text:String::new()},
            llm:crate::component::LlmConfig {base_url:String::new(),key:String::new(),model:String::new(),persona:String::new()},persona:String::new()},receiver)
    }
    #[tokio::test]
    async fn slot_actions_write_prompt_and_driver_with_the_same_task_identity_in_order() {
        for payload in [crate::avatar_action_payload("slot-1",None,Some("拿起口红轻涂双唇")).unwrap(),
            crate::gift_action_payload("slot-1","heart").unwrap(),crate::handoff_action_payload("slot-1","left_down",30).unwrap()] {
            let (mut session, mut receiver) = session();
            let receipts = enqueue(&mut session,payload).unwrap();
            let first = receiver.try_recv().unwrap(); let second = receiver.try_recv().unwrap();
            let a:Value = serde_json::from_str(first.message.to_text().unwrap()).unwrap();
            let b:Value = serde_json::from_str(second.message.to_text().unwrap()).unwrap();
            assert_eq!(a["type"],97); assert_eq!(b["type"],9);
            assert_eq!(a["seq_id"],101); assert_eq!(b["seq_id"],102);
            assert_eq!(a["payload"]["session_update"]["action_description"],b["payload"]["text_msg"]["content"]);
            assert!(b["payload"]["text_msg"]["msg_id"].as_str().unwrap().ends_with("slot-1"));
            assert!(!a.to_string().contains("not-sent"));
            first.written.unwrap().send(Ok(())).unwrap(); second.written.unwrap().send(Ok(())).unwrap();
            wait(receipts).await.unwrap(); assert!(receiver.try_recv().is_err());
        }
    }
    #[tokio::test]
    async fn enqueue_is_not_reported_as_written_and_a_failed_driver_is_propagated() {
        let (mut session, mut receiver) = session();
        let receipts = enqueue(&mut session,crate::gift_action_payload("slot","heart").unwrap()).unwrap();
        let first = receiver.try_recv().unwrap(); let second = receiver.try_recv().unwrap();
        first.written.unwrap().send(Ok(())).unwrap();
        let pending = wait(receipts); tokio::pin!(pending);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(20),&mut pending).await.is_err());
        session.speech_cancel.send_modify(|epoch| *epoch += 1);
        let (watch, epoch) = second.epoch.unwrap(); assert_ne!(*watch.borrow(),epoch);
        second.written.unwrap().send(Err("动作已取消".into())).unwrap();
        assert_eq!(pending.await.unwrap_err(),"动作已取消");
    }
    #[test]
    fn unready_sessions_do_not_enqueue_any_action() {
        let (mut session, mut receiver) = session(); session.ready=false;
        assert!(enqueue(&mut session,crate::gift_action_payload("slot","heart").unwrap()).is_err());
        assert!(receiver.try_recv().is_err());
    }
}
