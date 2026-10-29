use crate::{AppState, Outbound, queue_signal, unix_ms};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;
use crate::speech_text::{SpeechReply, split_sentence};

pub(crate) fn cancel_live_speech(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    if let Some(session) = guard.as_mut().filter(|s| s.external_audio.is_none()) {
        session.speech_cancel.send_modify(|epoch| *epoch += 1);
        session.speaking = false;
        let _ = queue_signal(app, session, 7, json!({}), None);
    }
    Ok(())
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct TtsConfig {
    pub base_url: String,
    #[serde(default)] pub key: String,
    pub model: String,
    pub ref_audio: String,
    pub ref_text: String,
}

#[derive(Clone, Deserialize)]
pub struct LlmConfig { pub base_url: String, pub key: String, pub model: String, pub persona: String }

pub(crate) fn endpoint(base: &str, path: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(base.trim()).map_err(|_| "服务地址无效".to_string())?;
    if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("服务地址须为 HTTP(S) 基础地址，不能包含凭证或查询参数".into());
    }
    Ok(format!("{}/{}", base.trim().trim_end_matches('/'), path))
}

pub fn validate(tts: &TtsConfig, llm: &LlmConfig) -> Result<(), String> {
    endpoint(&tts.base_url, "api/tts")?;
    endpoint(&llm.base_url, "chat/completions")?;
    if tts.model.trim().is_empty() || tts.ref_audio.trim().is_empty() || tts.ref_text.trim().is_empty() {
        return Err("请在 OmniVoice 配置中填写模型、参考音频和参考文字".into());
    }
    if llm.key.trim().is_empty() || llm.model.trim().is_empty() || llm.persona.trim().is_empty() {
        return Err("请保存大语言模型地址、Key、模型和主播人设".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn component_preflight(tts: TtsConfig) -> Result<Value, String> {
    let data = crate::speech_runtime::service_health(&tts).await.map_err(|_| "无法连接本机语音服务，请先启动 FunASR / OmniVoice 服务".to_string())?;
    crate::speech_runtime::validate_health(&data)?;
    if tts.model != crate::speech_runtime::MODEL { return Err("请保存 OmniVoice 语音配置".into()); }
    let reference = tts.ref_audio.trim_matches(|c: char| c.is_whitespace() || matches!(c, '"' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'));
    if tts.base_url.starts_with("http://127.0.0.1:") && !reference.is_empty() && !std::path::Path::new(reference).is_file() {
        return Err("本机参考音频文件不存在，请重新选择路径".into());
    }
    Ok(data)
}

#[tauri::command]
pub fn component_local_voice(app: tauri::AppHandle) -> Result<Value, String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let path = [root.join("speech/voice.json"), root.join("qwen3-tts/voice.json")].into_iter().find(|p| p.is_file());
    match path {
        Some(path) => serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string()),
        None => Ok(Value::Null),
    }
}

#[tauri::command]
pub async fn component_tts_preview(app: tauri::AppHandle, tts: TtsConfig, text: String) -> Result<String, String> {
    app.state::<crate::prepared_speech::PreparedSpeech>().preempt();
    if text.trim().is_empty() || text.chars().count() > 200 { return Err("试听文本需为1到200字".into()); }
    let (tx, rx) = mpsc::channel(1); tx.send(text).await.map_err(|_| "试听取消")?; drop(tx);
    let (audio, mut received) = mpsc::channel(1);
    synthesize(tts, uuid::Uuid::new_v4().to_string(), rx, audio).await?;
    let (_, pcm) = received.recv().await.ok_or("试听没有返回音频")?;
    Ok(format!("data:audio/wav;base64,{}", base64::engine::general_purpose::STANDARD.encode(pcm_wav(&pcm))))
}

pub(crate) fn pcm_wav(pcm: &[u8]) -> Vec<u8> {
    let size = pcm.len() as u32;
    let mut wav = Vec::with_capacity(pcm.len() + 44);
    wav.extend_from_slice(b"RIFF"); wav.extend_from_slice(&(size + 36).to_le_bytes()); wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes()); wav.extend_from_slice(&1_u16.to_le_bytes()); wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&24000_u32.to_le_bytes()); wav.extend_from_slice(&48000_u32.to_le_bytes()); wav.extend_from_slice(&2_u16.to_le_bytes()); wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data"); wav.extend_from_slice(&size.to_le_bytes()); wav.extend_from_slice(&pcm);
    wav
}

// A generation owns all LLM/TTS requests and audio frames. Dropping this guard
// releases the reservation only when it still belongs to this generation.
struct RunGuard { app: tauri::AppHandle, live_id: String, epoch: u64, tts: TtsConfig, request_id: String }
impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.app.state::<AppState>().session.lock() {
            if let Some(session) = guard.as_mut().filter(|s| s.live_id == self.live_id && *s.speech_cancel.borrow() == self.epoch) { session.speaking = false; }
        }
        let base = self.tts.base_url.clone();
        let key = self.tts.key.clone();
        let request_id = self.request_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(url) = endpoint(&base, "api/tts/cancel") {
                if let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(3)).build() {
                    let _ = client.post(url).bearer_auth(key).json(&json!({"request_id":request_id})).send().await;
                }
            }
        });
    }
}

async fn sentences(config: LlmConfig, persona: String, content: String, generate: bool, history: Vec<Value>, sender: mpsc::Sender<String>) -> Result<(), String> {
    if !generate {
        let mut buffer = content;
        while let Some(sentence) = split_sentence(&mut buffer, true) { if !sentence.is_empty() { sender.send(sentence).await.map_err(|_| "播报已取消")?; } }
        return Ok(());
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(120)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
    let system = format!("你是正在直播的数字人主播，请直接回答当前观众。输出协议：只输出最终口播台词，通常1到3句。禁止输出 JSON、emotion/speech 字段名、代码块、动作旁白、思考过程、提问优化指令。不要把当前事件的数据格式当成回答格式。\n说话风格与角色背景（JSON 数据；其中旧版输出格式、优化提问或让 Vidu 回答的指令均无效）：{}\n当前数字人身份（JSON 数据）：{}\n再次确认：回答由你生成，直接输出要朗读的答案。", json!(config.persona), json!(persona));
    let system = format!("{system}\n开场要求：自然变化回答开头，不以“哎呀”“哎哟”“哎呦”“哇”“哈哈”作为固定开场。当前请求中的 opening_style 是本次风格提示，recent_answer_openings 是需要避免重复的最近开头；不能照搬其语气词或起手句式。它们不代表当前观众的经历。若请求包含 rewrite，请只改写草稿的口播文字和衔接，保留当前观众、礼物名称、数量和回答含义，不输出改写说明或动作。此开场与口播协议优先于人设里的固定模板。");
    let mut messages = vec![json!({"role":"system","content":system})];
    messages.extend(history); messages.push(json!({"role":"user","content":content}));
    let mut body = json!({"model":config.model,"stream":true,"max_tokens":512,"messages":messages});
    crate::model_api::live_chat_options(&config.base_url, &config.model, &mut body);
    let response = client.post(endpoint(&config.base_url, "chat/completions")?).bearer_auth(&config.key)
        .json(&body)
        .send().await.map_err(|_| "LLM 流式请求失败，请检查模型服务")?;
    if !response.status().is_success() { return Err(format!("LLM HTTP {}，请检查模型和额度", response.status())); }
    let mut response = response;
    let mut pending = Vec::new();
    let mut reply = SpeechReply::default();
    let mut done = false;
    let mut any = false;
    while let Some(chunk) = response.chunk().await.map_err(|_| "LLM 流式连接中断")? {
        pending.extend_from_slice(&chunk);
        if pending.len() > 1024 * 1024 { return Err("LLM 流式帧过大".into()); }
        while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
            let line = pending.drain(..=end).collect::<Vec<_>>();
            let line = std::str::from_utf8(&line).map_err(|_| "LLM 返回了无效 UTF-8")?.trim();
            let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue; };
            if data == "[DONE]" { done = true; break; }
            let event: Value = serde_json::from_str(data).map_err(|_| "LLM SSE 数据无效")?;
            if event.get("error").is_some() { return Err("LLM 返回流式错误".into()); }
            if let Some(delta) = event.pointer("/choices/0/delta/content").and_then(Value::as_str) {
                reply.push(delta)?; any |= !delta.trim().is_empty();
                while let Some(sentence) = reply.next(false)? {
                    if !sentence.is_empty() { sender.send(sentence).await.map_err(|_| "播报已取消")?; }
                }
            }
            if let Some(reason) = event.pointer("/choices/0/finish_reason").and_then(Value::as_str) {
                if reason != "stop" { return Err(format!("LLM 回复未完整结束（{reason}），已停止后续音频")); }
                done = true;
            }
        }
        if done { break; }
    }
    if !done { return Err("LLM 未正常结束，已停止后续音频".into()); }
    if !any { return Err("LLM 返回空回答".into()); }
    while let Some(sentence) = reply.next(true)? { if !sentence.is_empty() { sender.send(sentence).await.map_err(|_| "播报已取消")?; } }
    Ok(())
}

pub(crate) static TTS_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn synthesize(config: TtsConfig, request_id: String, mut sentences: mpsc::Receiver<String>, audio: mpsc::Sender<(String, Vec<u8>)>) -> Result<(), String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(180)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
    while let Some(text) = sentences.recv().await {
        let _inference = TTS_GATE.lock().await;
        let pcm = synthesize_sentence(&client, &config, &request_id, &text).await?;
        drop(_inference);
        audio.send((text, pcm)).await.map_err(|_| "播报已取消")?;
    }
    Ok(())
}

pub(crate) async fn synthesize_sentence(client: &reqwest::Client, config: &TtsConfig, request_id: &str, text: &str) -> Result<Vec<u8>, String> {
    let response = client.post(endpoint(&config.base_url, "api/tts")?).bearer_auth(&config.key)
        .json(&json!({"model":config.model,"input":text,"ref_audio":config.ref_audio,"ref_text":config.ref_text,"response_format":"pcm","stream":false,"language":"Chinese","request_id":request_id}))
        .send().await.map_err(|_| "OmniVoice 合成请求失败")?;
    if !response.status().is_success() {
        let status = response.status();
        let error = response.json::<Value>().await.ok().and_then(|v| v["error"].as_str().map(|s| s.chars().take(500).collect::<String>())).unwrap_or_else(|| "请检查语音服务日志和参考音频".into());
        return Err(format!("OmniVoice HTTP {status}：{error}"));
    }
    let headers = response.headers();
    if headers.get("x-audio-sample-rate").and_then(|v| v.to_str().ok()) != Some("24000")
        || headers.get("x-audio-channels").and_then(|v| v.to_str().ok()) != Some("1")
        || headers.get("x-audio-format").and_then(|v| v.to_str().ok()) != Some("s16le") {
        return Err("TTS 必须返回带格式响应头的 24kHz 单声道 s16le PCM，请使用配套本地服务".into());
    }
    let mut response = response;
    let mut pcm = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "TTS 音频传输中断")? {
        pcm.extend_from_slice(&chunk);
        if pcm.len() > 48_000 * 60 { return Err("单句合成超过60秒，已停止播报".into()); }
    }
    validate_pcm(&pcm)?;
    Ok(pcm)
}

fn validate_pcm(pcm: &[u8]) -> Result<(), String> {
    if pcm.is_empty() || pcm.len() % 2 != 0 || pcm.starts_with(b"RIFF") || pcm.starts_with(b"ID3") || pcm.starts_with(b"OggS") {
        return Err("TTS 返回的音频不是裸 PCM s16le".into());
    }
    Ok(())
}

async fn send_audio(app: &tauri::AppHandle, live_id: &str, task_id: &str, epoch: u64, cancel: watch::Receiver<u64>, mut audio: mpsc::Receiver<(String, Vec<u8>)>, first_pcm:oneshot::Sender<tokio::time::Instant>) -> Result<String, String> {
    let mut answer = String::new();
    let mut duration = 0_u64;
    let mut first_pcm=Some(first_pcm);
    while let Some((text, pcm)) = audio.recv().await {
        answer.push_str(&text);
        {
            let state = app.state::<AppState>();
            let mut guard = state.session.lock().map_err(|e| e.to_string())?;
            let session = guard.as_mut().filter(|s| s.live_id == live_id && *s.speech_cancel.borrow() == epoch && s.ready).ok_or("播报已取消或会话未就绪")?;
            queue_signal(app, session, 10, json!({"text_msg":{"msg_id":format!("tts-{task_id}"),"content":text,"timestamp":unix_ms()}}), None)?;
        }
        emit_answer(app, live_id, task_id, &answer, false);
        // Await every socket write and pace by audio duration. This bounds the
        // upstream backlog and makes interruption independent of reply length.
        let mut deadline = tokio::time::Instant::now();
        for chunk in pcm.chunks(960) {
            tokio::time::sleep_until(deadline).await;
            let (written, received) = oneshot::channel();
            {
                let state = app.state::<AppState>();
                let guard = state.session.lock().map_err(|e| e.to_string())?;
                let session = guard.as_ref().filter(|s| s.live_id == live_id && *s.speech_cancel.borrow() == epoch && s.ready).ok_or("播报已取消")?;
                session.sender.send(Outbound { message: Message::Binary(chunk.to_vec().into()), written: Some(written), epoch: Some((cancel.clone(), epoch)) }).map_err(|_| "PCM 发送通道已关闭")?;
            }
            tokio::time::timeout(Duration::from_secs(4), received).await.map_err(|_| "PCM 写入超时")?.map_err(|_| "PCM 写入未确认")??;
            {
                // Serialize local playback with interruption. A late write
                // receipt must never restart audio from a cancelled epoch.
                let state = app.state::<AppState>();
                let guard = state.session.lock().map_err(|e| e.to_string())?;
                guard.as_ref().filter(|s| s.live_id == live_id && *s.speech_cancel.borrow() == epoch && s.ready).ok_or("播报已取消")?;
                app.emit_to("obs", "component-pcm", json!({"live_id":live_id,"task_id":task_id,"epoch":epoch,"state":"frame","pcm":chunk})).map_err(|e| format!("本地PCM播放投递失败：{e}"))?;
            }
            if let Some(first)=first_pcm.take() {let _=first.send(tokio::time::Instant::now());}
            deadline += Duration::from_secs_f64(chunk.len() as f64 / 48_000.0);
            let now = tokio::time::Instant::now();
            if now.saturating_duration_since(deadline) > Duration::from_millis(100) { deadline = now; }
        }
        tokio::time::sleep_until(deadline).await;
        duration += pcm.len() as u64 / 48;
        let _ = app.emit("component-speech", json!({"live_id":live_id,"task_id":task_id,"state":"sentence_sent","duration_ms":duration}));
    }
    if answer.is_empty() { return Err("没有可播报的音频".into()); }
    // This means transmission finished, never that RTC playback has finished.
    emit_answer(app, live_id, task_id, &answer, true);
    let _ = app.emit("component-speech", json!({"live_id":live_id,"task_id":task_id,"state":"sent","duration_ms":duration}));
    Ok(answer)
}

fn emit_answer(app: &tauri::AppHandle, live_id: &str, task_id: &str, answer: &str, final_: bool) {
    let _ = app.emit("vidu-signal", json!({"type":10,"live_id":live_id,"received_at":unix_ms(),"payload":{"text_msg":{"msg_id":format!("tts-{task_id}"),"request_id":task_id,"content":answer,"is_final":final_}}}));
}

pub async fn run(app: tauri::AppHandle, live_id: String, content: String, task_id: String, generate: bool) -> Result<(), String> {
    run_audio(app, live_id, content, task_id, generate, None, None).await
}

pub(crate) async fn run_audio(app: tauri::AppHandle, live_id: String, content: String, task_id: String, generate: bool, prepared: Option<std::sync::Arc<crate::prepared_speech::PreparedAudio>>, mut slot_actions:Option<crate::component_action::PreparedSlotActions>) -> Result<(), String> {
    if prepared.is_none() { app.state::<crate::prepared_speech::PreparedSpeech>().preempt(); }
    if content.trim().is_empty() { return Err("播报内容不能为空".into()); }
    let conversational = task_id.starts_with("manual-") || task_id.starts_with("microphone-");
    let (tts, llm, persona, epoch, mut cancel, history) = {
        let state = app.state::<AppState>();
        let mut guard = state.session.lock().map_err(|e| e.to_string())?;
        let session = guard.as_mut().filter(|s| s.live_id == live_id && s.ready).ok_or("组件会话尚未就绪或已结束")?;
        if session.song_audio.as_ref().is_some_and(|s|s.active) {return Err("歌曲唱词期间暂停弹幕PCM".into());}
        if session.speaking { return Err("当前仍有音频在发送，请等待完成或先打断".into()); }
        session.reply_task=Some(task_id.clone());
        if conversational {
            queue_signal(&app, session, 9, json!({"text_msg":{"msg_id":format!("input-{task_id}"),"content":content,"timestamp":unix_ms()}}), None)?;
        }
        session.speaking = true;
        session.speech_cancel.send_modify(|value| *value += 1);
        let epoch = *session.speech_cancel.borrow();
        (session.tts.clone(), session.llm.clone(), session.persona.clone(), epoch, session.speech_cancel.subscribe(), if conversational { session.conversation.clone() } else { Vec::new() })
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    let _guard = RunGuard { app: app.clone(), live_id: live_id.clone(), epoch, tts: tts.clone(), request_id: request_id.clone() };
    let _ = app.emit("component-speech", json!({"live_id":live_id,"task_id":task_id,"state":"generating"}));
    let (sentence_tx, sentence_rx) = mpsc::channel(2);
    let (audio_tx, audio_rx) = mpsc::channel(1);
    let audio_cancel = cancel.clone();
    let question = content.clone();
    let pipeline = async {
        if let Some(actions)=&mut slot_actions {
            if let Some(handoff)=actions.handoff.take() {
                crate::component_action::submit(&app,&live_id,&task_id,epoch,&actions.playback_token,"handoff",handoff).await;
            }
        }
        let (first_tx,first_rx)=oneshot::channel();
        let (finished_tx,finished_rx)=watch::channel(false);
        let produce = async {
            if let Some(prepared) = prepared {
                drop(sentence_tx); drop(sentence_rx);
                crate::prepared_speech::feed(prepared, audio_tx).await?;
                Ok::<(),String>(())
            } else {
                tokio::try_join!(sentences(llm, persona, content, generate, history, sentence_tx), synthesize(tts, request_id, sentence_rx, audio_tx))?;
                Ok(())
            }
        };
        let transmit=async {
            let result=send_audio(&app,&live_id,&task_id,epoch,audio_cancel,audio_rx,first_tx).await;
            finished_tx.send_replace(true);result
        };
        let reply=async {
            if let Some(actions)=&mut slot_actions {
                if let Some(payload)=actions.reply.take() {
                    if crate::component_action::reply_due(actions.reply_delay_ms,first_rx,finished_rx).await {
                        crate::component_action::submit(&app,&live_id,&task_id,epoch,&actions.playback_token,"reply",payload).await;
                    } else {
                        crate::component_action::report(&app,&live_id,&task_id,&actions.playback_token,"reply","cancelled",Some("PCM已停止发送，取消尚未触发的回复动作"));
                    }
                }
            }
            Ok::<(),String>(())
        };
        let (_, answer, _) = tokio::try_join!(produce, transmit, reply)?;
        Ok::<String, String>(answer)
    };
    let result = tokio::select! {
        biased;
        _ = cancel.changed() => Err("播报已打断".into()),
        result = pipeline => result,
    };
    if let Err(error) = &result {
        let _ = app.emit_to("obs", "component-pcm", json!({"live_id":live_id,"epoch":epoch,"state":"stop"}));
        // A partial reply can already be rendering when its next LLM/TTS
        // request fails. Clear that generation without interrupting a new one.
        let state = app.state::<AppState>();
        if let Ok(mut guard) = state.session.lock() {
            if let Some(session) = guard.as_mut().filter(|s| s.live_id == live_id && *s.speech_cancel.borrow() == epoch) {
                session.speaking = false;
                session.speech_cancel.send_modify(|value| *value += 1);
                let _ = queue_signal(&app, session, 7, json!({}), None);
            }
        }
        let _ = app.emit("component-speech", json!({"live_id":live_id,"task_id":task_id,"state":"error","error":error}));
    }
    if let Ok(answer) = &result {
        if conversational {
            let state = app.state::<AppState>();
            if let Ok(mut guard) = state.session.lock() {
                if let Some(session) = guard.as_mut().filter(|s| s.live_id == live_id && *s.speech_cancel.borrow() == epoch) {
                    session.conversation.push(json!({"role":"user","content":question}));
                    session.conversation.push(json!({"role":"assistant","content":answer}));
                    if session.conversation.len() > 12 { session.conversation.drain(..session.conversation.len()-12); }
                }
            };
        }
    }
    result.map(|_| ())
}

#[tauri::command]
pub async fn component_prepare_reply(state: State<'_, AppState>, live_id: String, llm: LlmConfig, content: String) -> Result<String, String> {
    let persona = {
        let guard = state.session.lock().map_err(|e| e.to_string())?;
        guard.as_ref().filter(|s| s.live_id == live_id && s.ready).ok_or("原会话已结束，回答预生成已取消")?.persona.clone()
    };
    let (tx, mut rx) = mpsc::channel::<String>(2);
    let collect = async { let mut text = String::new(); while let Some(part) = rx.recv().await { text.push_str(&part); } Ok::<String,String>(text) };
    let (_, text) = tokio::try_join!(sentences(llm, persona, content, true, Vec::new(), tx), collect)?;
    if !state.session.lock().map_err(|e| e.to_string())?.as_ref().is_some_and(|s| s.live_id == live_id && s.ready) { return Err("会话已结束，已丢弃预生成回答".into()); }
    if text.trim().is_empty() { return Err("模型未返回有效口播答案".into()); }
    Ok(text)
}

#[tauri::command]
pub async fn component_respond(app: tauri::AppHandle, live_id: String, content: String, task_id: String) -> Result<(), String> {
    run(app, live_id, content, task_id, true).await
}

#[tauri::command]
pub fn component_configure(state: State<'_, AppState>, live_id: String, tts: TtsConfig, llm: LlmConfig) -> Result<(), String> {
    validate(&tts, &llm)?;
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = guard.as_mut().filter(|s| s.live_id == live_id).ok_or("会话已结束")?;
    if session.song_audio.as_ref().is_some_and(|s|s.active) {return Err("歌曲唱词期间暂停弹幕PCM".into());}
    if session.speaking { return Err("请等待当前播报发送结束再修改语音配置".into()); }
    session.tts = tts; session.llm = llm;
    Ok(())
}

#[tauri::command]
pub fn component_audio_begin(state: State<'_, AppState>, live_id: String, token: String) -> Result<(), String> {
    if token.is_empty() || token.len() > 200 { return Err("歌曲音频标识无效".into()); }
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = guard.as_mut().filter(|s| s.live_id == live_id && s.ready).ok_or("组件会话尚未就绪")?;
    if session.song_audio.is_some(){return Err("歌曲请使用分段音频通道".into());}
    if session.speaking { return Err("请先停止当前音频再播放歌曲".into()); }
    session.speech_cancel.send_modify(|value| *value += 1);
    session.speaking = true;
    session.external_audio = Some((token, 0));
    Ok(())
}

#[tauri::command]
pub async fn component_audio_push(state: State<'_, AppState>, live_id: String, token: String, sequence: u64, samples: Vec<i16>) -> Result<(), String> {
    if !matches!(samples.len(),480|2400) { return Err("歌曲PCM需为20或100毫秒、24kHz单声道帧".into()); }
    let (written, received) = oneshot::channel();
    {
        let mut guard = state.session.lock().map_err(|e| e.to_string())?;
        let session = guard.as_mut().filter(|s| s.live_id == live_id && s.ready && s.external_audio.as_ref().is_some_and(|(id, seq)| id == &token && *seq == sequence)).ok_or("歌曲音频已取消或帧顺序错误")?;
        let pcm = samples.into_iter().flat_map(i16::to_le_bytes).collect::<Vec<_>>();
        session.sender.send(Outbound { message: Message::Binary(pcm.into()), written: Some(written), epoch: Some((session.speech_cancel.subscribe(), *session.speech_cancel.borrow())) }).map_err(|_| "音频通道已关闭")?;
        session.external_audio.as_mut().unwrap().1 += 1;
    }
    tokio::time::timeout(Duration::from_secs(4), received).await.map_err(|_| "歌曲音频写入超时")?.map_err(|_| "歌曲音频写入未确认")?
}

#[tauri::command]
pub fn component_transcription(app: tauri::AppHandle, state: State<'_, AppState>, live_id: String, task_id: String, content: String) -> Result<(), String> {
    if content.trim().is_empty() || content.chars().count() > 1000 { return Err("转写文字无效".into()); }
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = guard.as_mut().filter(|s| s.live_id == live_id && s.ready).ok_or("组件会话尚未就绪")?;
    queue_signal(&app, session, 10, json!({"text_msg":{"msg_id":format!("tts-{task_id}"),"content":content,"timestamp":unix_ms()}}), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{BufRead, BufReader, Read, Write}, net::TcpListener, thread};

    fn llm(base_url: String) -> LlmConfig { LlmConfig { base_url, key:"test-key".into(), model:"test-model".into(), persona:"主播规则".into() } }

    fn server(body: Vec<u8>, headers: &str, pause: Option<(usize, std::sync::mpsc::Receiver<()>)>) -> (String, thread::JoinHandle<Value>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let headers = headers.to_string();
        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut length = 0;
            loop {
                let mut line = String::new(); reader.read_line(&mut line).unwrap();
                if line == "\r\n" { break; }
                if let Some(value) = line.to_lowercase().strip_prefix("content-length:") { length = value.trim().parse().unwrap(); }
            }
            let mut request = vec![0; length]; reader.read_exact(&mut request).unwrap();
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n", body.len(), headers).unwrap();
            if let Some((offset, wait)) = pause {
                socket.write_all(&body[..offset]).unwrap(); socket.flush().unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                socket.write_all(&body[offset..]).unwrap();
            } else {
                // Deliberately split UTF-8 sequences and SSE lines.
                for chunk in body.chunks(3) { if socket.write_all(chunk).is_err() { break; } }
            }
            serde_json::from_slice(&request).unwrap()
        });
        (url, handle)
    }

    #[tokio::test]
    async fn first_sentence_is_dispatched_before_the_model_finishes() {
        let first = format!("data: {}\n\n", json!({"choices":[{"delta":{"content":"你好。"}}]}));
        let rest = format!("data: {}\n\ndata: [DONE]\n\n", json!({"choices":[{"delta":{"content":"欢迎来到直播间。"},"finish_reason":"stop"}]}));
        let (release, wait) = std::sync::mpsc::channel();
        let (url, server) = server(format!("{first}{rest}").into_bytes(), "Content-Type: text/event-stream\r\n", Some((first.len(), wait)));
        let (tx, mut rx) = mpsc::channel(2);
        let consume = async {
            assert_eq!(rx.recv().await.as_deref(), Some("你好。"));
            release.send(()).unwrap();
            assert_eq!(rx.recv().await.as_deref(), Some("欢迎来到直播间。"));
        };
        let (result, _) = tokio::join!(sentences(llm(url), "当前身份".into(), "你好".into(), true, Vec::new(), tx), consume);
        result.unwrap();
        let request = server.join().unwrap(); assert_eq!(request["stream"], true);
        assert!(request["messages"][0]["content"].as_str().unwrap().contains("最终口播台词"));
    }

    #[tokio::test]
    async fn truncated_model_stream_is_not_treated_as_a_complete_reply() {
        let body = format!("data: {}\n\n", json!({"choices":[{"delta":{"content":"没说完"}}]}));
        let (url, server) = server(body.into_bytes(), "Content-Type: text/event-stream\r\n", None);
        let (tx, mut rx) = mpsc::channel(2);
        assert!(sentences(llm(url), "身份".into(), "问题".into(), true, Vec::new(), tx).await.unwrap_err().contains("未正常结束"));
        assert!(rx.recv().await.is_none()); server.join().unwrap();
    }

    #[tokio::test]
    async fn legacy_json_reply_is_unwrapped_before_tts_and_metadata_is_never_dispatched() {
        let first = format!("data: {}\n\n", json!({"choices":[{"delta":{"content":"{\"emotion\": \"playful\",\n"}}]}));
        let rest = format!("data: {}\n\ndata: [DONE]\n\n", json!({"choices":[{"delta":{"content":"\"speech\": \"小宇，这是姐姐的小秘密呀。\",\"action_instruction\":\"看向镜头\"}"},"finish_reason":"stop"}]}));
        let (url, server) = server(format!("{first}{rest}").into_bytes(), "Content-Type: text/event-stream\r\n", None);
        let (tx, mut rx) = mpsc::channel(2);
        sentences(llm(url), "姐姐主播".into(), "姐姐你有男朋友吗？".into(), true, Vec::new(), tx).await.unwrap();
        assert_eq!(rx.recv().await.as_deref(),Some("小宇，这是姐姐的小秘密呀。"));
        assert!(rx.recv().await.is_none());
        let request = server.join().unwrap();
        let prompt = request["messages"][0]["content"].as_str().unwrap();
        assert!(prompt.contains("回答由你生成")); assert!(prompt.contains("禁止输出 JSON"));
    }

    #[tokio::test]
    #[ignore = "reads saved local LLM/TTS config from stdin; calls the configured LLM and local TTS, never Vidu"]
    async fn local_deepseek_reply_clone() {
        #[derive(Deserialize)]
        struct Probe { llm: LlmConfig, tts: TtsConfig, persona: String }
        let mut input = String::new(); std::io::stdin().read_to_string(&mut input).unwrap();
        let config: Probe = serde_json::from_str(&input).expect("probe configuration missing");
        let (sentences_tx, sentences_rx) = mpsc::channel(2);
        let (audio_tx, mut audio_rx) = mpsc::channel::<(String, Vec<u8>)>(1);
        let content = json!({"current_event":{"type":"chat","nickname":"小宇","content":"姐姐你有男朋友吗？"},"viewer_history":[]}).to_string();
        let collect = async {
            let mut answer = String::new(); let mut pcm = Vec::new(); let mut count = 0;
            while let Some((text, audio)) = audio_rx.recv().await {
                assert!(!text.starts_with(['{','[','`'])); validate_pcm(&audio)?;
                answer.push_str(&text); pcm.extend_from_slice(&audio); count += 1;
            }
            Ok::<_,String>((answer, pcm, count))
        };
        let started = std::time::Instant::now();
        let (_, _, (answer, pcm, count)) = tokio::try_join!(sentences(config.llm, config.persona, content, true, Vec::new(), sentences_tx),
            synthesize(config.tts, uuid::Uuid::new_v4().to_string(), sentences_rx, audio_tx), collect).unwrap();
        assert!(!answer.trim().is_empty()); assert!(!pcm.is_empty());
        let output = std::path::PathBuf::from(std::env::var_os("SPEECH_PROBE_OUTPUT").expect("SPEECH_PROBE_OUTPUT is required"));
        std::fs::write(&output, pcm_wav(&pcm)).unwrap();
        println!("{}", json!({"answer":answer,"sentences":count,"audio_seconds":pcm.len() as f64/48000.0,"elapsed_seconds":started.elapsed().as_secs_f64(),"output":output}));
    }

    #[tokio::test]
    async fn tts_format_is_checked_before_any_audio_can_be_submitted() {
        let (url, server) = server(vec![0;960], "X-Audio-Sample-Rate: 16000\r\nX-Audio-Channels: 1\r\nX-Audio-Format: s16le\r\n", None);
        let config = TtsConfig { base_url:url, key:String::new(), model:"base".into(), ref_audio:"reference.wav".into(), ref_text:"原话".into() };
        let (tx, rx) = mpsc::channel(2); tx.send("你好。".into()).await.unwrap(); drop(tx);
        let (audio, mut received) = mpsc::channel(1);
        assert!(synthesize(config, "request".into(), rx, audio).await.unwrap_err().contains("24kHz"));
        assert!(received.recv().await.is_none()); server.join().unwrap();
    }

    #[tokio::test]
    #[ignore = "reads local LLM config and reply requests from stdin; checks real spoken reply generation without Vidu or TTS"]
    async fn local_reply_opening_diversity() {
        #[derive(Deserialize)]
        struct Probe { llm:LlmConfig, persona:String, requests:Vec<Value> }
        let mut input=String::new();std::io::stdin().read_to_string(&mut input).unwrap();
        let config:Probe=serde_json::from_str(&input).expect("local LLM config required");
        assert!(!config.requests.is_empty()&&config.requests.len()<=6);
        let mut replies=Vec::new();
        for request in config.requests {
            let (tx,mut rx)=mpsc::channel::<String>(2);
            let collect=async {let mut out=String::new();while let Some(part)=rx.recv().await{out.push_str(&part);}Ok::<_,String>(out)};
            let (_,text)=tokio::try_join!(sentences(config.llm.clone(),config.persona.clone(),request.to_string(),true,Vec::new(),tx),collect).unwrap();
            assert!(!text.trim().is_empty());replies.push(text);
        }
        println!("{}",json!({"replies":replies}));
    }
    #[test]
    fn sentence_chunks_preserve_text_and_flush_tail() {
        let mut text = "你好。今天好吗？最后一句".to_string();
        assert_eq!(split_sentence(&mut text, false).as_deref(), Some("你好。"));
        assert_eq!(split_sentence(&mut text, false).as_deref(), Some("今天好吗？"));
        assert_eq!(split_sentence(&mut text, false), None);
        assert_eq!(split_sentence(&mut text, true).as_deref(), Some("最后一句"));
        assert_eq!(split_sentence(&mut text, true), None);
    }
    #[test]
    fn audio_rejects_containers_and_partial_samples() {
        assert!(validate_pcm(b"RIFF0000").is_err());
        assert!(validate_pcm(&[1]).is_err());
        assert!(validate_pcm(&[0, 1, 2, 3]).is_ok());
    }
}
