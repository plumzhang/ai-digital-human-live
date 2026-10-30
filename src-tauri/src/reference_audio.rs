use tauri_plugin_dialog::DialogExt;

const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "flac", "ogg", "m4a", "aac", "opus", "aiff", "aif", "wma"];

#[tauri::command]
pub async fn component_pick_reference_audio(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window.dialog().file()
        .set_parent(&window)
        .set_title("选择参考音频")
        .add_filter("音频文件", AUDIO_EXTENSIONS)
        .pick_file(move |file| { let _ = sender.send(file); });
    let file = receiver.await.map_err(|_| "文件选择窗口已关闭".to_string())?;
    file.map(|file| {
        let path = file.into_path().map_err(|e| format!("无法获取音频文件路径：{e}"))?;
        validate_reference_audio(&path)?;
        path.to_str().map(str::to_owned).ok_or_else(|| "音频文件路径编码无效".to_string())
    }).transpose()
}

fn validate_reference_audio(path: &std::path::Path) -> Result<(), String> {
    if !path.is_absolute() || !path.is_file() { return Err("所选音频文件不存在，请重新选择".into()); }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    if !AUDIO_EXTENSIONS.contains(&extension.as_str()) { return Err("请选择 WAV、MP3、FLAC 等音频文件".into()); }
    Ok(())
}

#[tauri::command]
pub async fn component_transcribe_reference_audio(tts: crate::component::TtsConfig) -> Result<String, String> {
    let path = std::path::Path::new(&tts.ref_audio);
    validate_reference_audio(path)?;
    crate::speech_stt::speech_prepare(tts.clone()).await?;
    let value = tokio::time::timeout(std::time::Duration::from_secs(125), crate::speech_stt::transcribe_file(&tts, path)).await
        .map_err(|_| "参考音频识别超时，请稍后重新识别".to_string())??;
    reference_transcript(&value)
}

fn reference_transcript(value: &serde_json::Value) -> Result<String, String> {
    let segments = value["segments"].as_array().ok_or("FunASR 未返回识别字幕")?;
    let text = segments.iter().map(|segment| segment["text"].as_str().map(str::trim).ok_or("FunASR 字幕内容无效"))
        .collect::<Result<Vec<_>, _>>()?.into_iter().filter(|text| !text.is_empty()).collect::<Vec<_>>().join("\n");
    if text.is_empty() { return Err("未识别到原话，请检查参考音频，或手动填写原话".into()); }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_transcript_preserves_sentence_order_and_rejects_empty_or_invalid_results() {
        assert_eq!(reference_transcript(&serde_json::json!({"segments":[{"text":" 你好，欢迎来到直播间。 "},{"text":" "},{"text":"今天一起聊天吧。"}]})).unwrap(), "你好，欢迎来到直播间。\n今天一起聊天吧。");
        for value in [serde_json::json!({"segments":[]}), serde_json::json!({"segments":[{"text":"  "}]}), serde_json::json!({"segments":[{"text":123}]}), serde_json::json!({})] {
            assert!(reference_transcript(&value).is_err());
        }
    }

    #[test]
    fn selected_reference_requires_an_existing_absolute_audio_file() {
        let directory = std::env::temp_dir().join(format!("参考 音频-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("角色音色.WAV");
        std::fs::write(&file, b"reference").unwrap();
        assert!(validate_reference_audio(&file).is_ok());
        assert!(validate_reference_audio(std::path::Path::new("relative.wav")).is_err());
        assert!(validate_reference_audio(&directory).is_err());
        assert!(validate_reference_audio(&directory.join("missing.wav")).is_err());
        let other = directory.join("not-audio.txt");
        std::fs::write(&other, b"text").unwrap();
        assert!(validate_reference_audio(&other).unwrap_err().contains("音频文件"));
        std::fs::remove_file(other).unwrap(); std::fs::remove_file(file).unwrap(); std::fs::remove_dir(directory).unwrap();
    }
}
