use serde_json::Value;

/// Plain replies stream immediately. Structured replies must be complete before
/// extracting a dedicated speech field; metadata must never reach the TTS queue.
#[derive(Default)]
pub(crate) struct SpeechReply {
    buffer: String,
    structured: Option<bool>,
}

impl SpeechReply {
    pub fn push(&mut self, delta: &str) -> Result<(), String> {
        if self.buffer.len() + delta.len() > 64 * 1024 { return Err("模型口播内容过长".into()); }
        self.buffer.push_str(delta); Ok(())
    }

    pub fn next(&mut self, finish: bool) -> Result<Option<String>, String> {
        while self.structured.is_none() {
            let text = self.buffer.trim_start();
            let Some(first) = text.chars().next() else { return Ok(None); };
            if first == '<' {
                if let Some(end) = text.find("</think>").filter(|_| text.starts_with("<think>")) {
                    let consumed = self.buffer.len() - text.len() + end + "</think>".len();
                    self.buffer.drain(..consumed); continue;
                }
                if !finish && ("<think>".starts_with(text) || text.starts_with("<think>")) { return Ok(None); }
                return Err("模型返回了思考过程或标记，已阻止送入语音合成".into());
            }
            self.structured = Some(matches!(first, '{' | '[' | '`' | '"'));
        }
        if self.structured == Some(true) {
            if !finish { return Ok(None); }
            self.buffer = extract_speech(&self.buffer)?;
            self.structured = Some(false);
        }
        let pending = self.buffer.trim_start();
        if pending.starts_with(['{', '}', '[', ']', '`', '<']) || ["\"emotion\"", "\"speech\"", "\"action_instruction\""].iter().any(|key| pending.starts_with(key)) {
            return Err("模型口播中混入结构化字段，已停止后续语音合成".into());
        }
        Ok(split_sentence(&mut self.buffer, finish))
    }
}

fn extract_speech(text: &str) -> Result<String, String> {
    let mut raw = text.trim();
    if raw.starts_with("```") {
        raw = raw.split_once('\n').map(|(_, body)| body).ok_or("模型代码块没有口播内容")?;
        raw = raw.strip_suffix("```").ok_or("模型回复代码块未完整结束")?.trim();
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| "模型返回的结构化回答不完整，未发送任何结构化内容到 TTS")?;
    let speech = match &value {
        Value::String(text) => Some(text.clone()),
        Value::Object(_) => ["speech", "answer", "text"].iter().find_map(|key| value[*key].as_str().filter(|s| !s.trim().is_empty()).map(str::to_owned))
            .or_else(|| value["segments"].as_array().and_then(|items| {
                let texts: Option<Vec<&str>> = items.iter().map(|item| item["text"].as_str()).collect();
                texts.map(|texts| texts.join(""))
            })),
        _ => None,
    }.filter(|s| !s.trim().is_empty()).ok_or("模型结构化回答缺少有效口播 speech / answer / text，未送入 TTS")?;
    if speech.trim_start().starts_with(['{', '[', '`', '<']) { return Err("口播字段仍包含结构化内容，已阻止合成".into()); }
    Ok(speech.trim().to_owned())
}

pub(crate) fn split_sentence(buffer: &mut String, flush: bool) -> Option<String> {
    let mut count = 0;
    let end = buffer.char_indices().find_map(|(index, ch)| {
        count += 1;
        (matches!(ch, '。' | '！' | '？' | '!' | '?' | '\n' | '；' | ';') || count >= 100).then_some(index + ch.len_utf8())
    }).or_else(|| (flush && !buffer.is_empty()).then_some(buffer.len()))?;
    Some(buffer.drain(..end).collect::<String>().trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn json_metadata_is_held_until_only_spoken_answers_can_be_extracted() {
        let mut reply = SpeechReply::default();
        reply.push("{\"emotion\": \"playful\",\n").unwrap();
        assert!(reply.next(false).unwrap().is_none());
        reply.push("\"speech\":\"小宇，这是姐姐的小秘密呀。你猜呢？\",\"action_instruction\":\"看向镜头\"}").unwrap();
        assert!(reply.next(false).unwrap().is_none());
        assert_eq!(reply.next(true).unwrap().as_deref(), Some("小宇，这是姐姐的小秘密呀。"));
        assert_eq!(reply.next(true).unwrap().as_deref(), Some("你猜呢？"));
        assert!(reply.next(true).unwrap().is_none());
    }
    #[test]
    fn plain_speech_remains_sentence_streamed_and_reasoning_never_leaks() {
        let mut reply = SpeechReply::default();
        reply.push("<thi").unwrap(); assert!(reply.next(false).unwrap().is_none());
        reply.push("nk>先分析情感。不要读这段。</think>你好。").unwrap();
        assert_eq!(reply.next(false).unwrap().as_deref(), Some("你好。"));
        reply.push("欢迎来到直播间").unwrap(); assert!(reply.next(false).unwrap().is_none());
        assert_eq!(reply.next(true).unwrap().as_deref(), Some("欢迎来到直播间"));
    }
    #[test]
    fn malformed_or_metadata_only_json_cannot_produce_audio_text() {
        for text in ["{\"emotion\":\"playful\"}", "{\"speech\":\"未完", "[\"playful\"]", "{\"speech\":\"{\\\"emotion\\\":1}\"}"] {
            let mut reply = SpeechReply::default(); reply.push(text).unwrap();
            assert!(reply.next(false).unwrap().is_none()); assert!(reply.next(true).is_err());
        }
    }
    #[test]
    fn fenced_json_escaped_characters_and_segment_replies_are_supported() {
        for text in ["```json\n{\"emotion\":\"playful\",\"speech\":\"\\u4f60好。\"}\n```", "{\"segments\":[{\"text\":\"你好。\",\"action\":\"idle\"}]}", "{\"answer\":\"你好。\"}"] {
            let mut reply = SpeechReply::default(); reply.push(text).unwrap();
            assert_eq!(reply.next(true).unwrap().as_deref(), Some("你好。"));
        }
    }
}
