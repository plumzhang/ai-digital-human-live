use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}, time::UNIX_EPOCH};

#[derive(Serialize, Deserialize)]
pub(crate) struct Stems {
    schema: u32, revision: String, source_len: u64, source_modified: u128,
    frames: u64, vocals_len: u64, accompaniment_len: u64, vocals_modified: u128, accompaniment_modified: u128,
}
fn stamp(source: &Path) -> Result<(u64, u128), String> {
    let meta = fs::metadata(source).map_err(|e| e.to_string())?;
    Ok((meta.len(), meta.modified().map_err(|e| e.to_string())?.duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos()))
}
impl Stems {
    fn directory(&self, path: &Path) -> Result<PathBuf, String> {
        Ok(path.join("stems").join(uuid::Uuid::parse_str(&self.revision).map_err(|_| "歌曲分离版本无效")?.to_string()))
    }
    pub fn vocals(&self, path: &Path) -> Result<PathBuf, String> { Ok(self.directory(path)?.join("vocals.wav")) }
    pub fn accompaniment(&self, path: &Path) -> Result<PathBuf, String> { Ok(self.directory(path)?.join("accompaniment.wav")) }
}
pub(crate) fn load(path: &Path, source: &Path) -> Result<Stems, String> {
    let cache: Stems = serde_json::from_slice(&fs::read(path.join("stems.json")).map_err(|_| "请先分离人声与伴奏")?).map_err(|_| "歌曲分离清单无效，请重新分离")?;
    if cache.schema != 1 || stamp(source)? != (cache.source_len, cache.source_modified) {
        return Err("原歌曲已变化，请重新分离人声与伴奏".into());
    }
    if cache.frames < 44100 || cache.frames > 1801 * 44100
        || cache.vocals_len != cache.frames * 4 + 44 || cache.accompaniment_len != cache.vocals_len
        || stamp(&cache.vocals(path)?)? != (cache.vocals_len, cache.vocals_modified)
        || stamp(&cache.accompaniment(path)?)? != (cache.accompaniment_len, cache.accompaniment_modified) {
        return Err("人声或伴奏文件缺失、不完整，请重新分离".into());
    }
    Ok(cache)
}
pub(crate) fn build(path: &Path, source: &Path, separate: impl FnOnce(&Path, &Path) -> Result<(), String>) -> Result<Stems, String> {
    if let Ok(cache) = load(path, source) { return Ok(cache); }
    let (source_len, source_modified) = stamp(source)?;
    let revision = uuid::Uuid::new_v4().to_string();
    let work = path.join("stems").join(&revision);
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let outcome = (|| {
        separate(source, &work)?;
        let info: serde_json::Value = serde_json::from_slice(&fs::read(work.join("separation.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let frames = info["frames"].as_u64().filter(|n| (44100..=1801 * 44100).contains(n)).ok_or("歌曲分离结果时长无效")?;
        if info["model"] != "htdemucs" || info["sample_rate"] != 44100 || info["channels"] != 2 { return Err("歌曲分离格式无效".into()); }
        let (vocals_len, vocals_modified) = stamp(&work.join("vocals.wav"))?;
        let (accompaniment_len, accompaniment_modified) = stamp(&work.join("accompaniment.wav"))?;
        if vocals_len != frames * 4 + 44 || accompaniment_len != vocals_len { return Err("歌曲分离文件长度不完整".into()); }
        if stamp(source)? != (source_len, source_modified) { return Err("分离期间原歌曲已变化，请重试".into()); }
        let cache = Stems { schema: 1, revision, source_len, source_modified, frames, vocals_len, accompaniment_len, vocals_modified, accompaniment_modified };
        crate::queue_store::atomic_write(path, "stems.json", &serde_json::to_string_pretty(&cache).map_err(|e| e.to_string())?)?;
        Ok(cache)
    })();
    if outcome.is_err() { let _ = fs::remove_dir_all(&work); }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "uses the local GPU and the user's explicitly selected song; input via stdin"]
    fn local_real_separation_and_vocal_pcm() {
        use std::io::Read;
        let mut input = String::new(); std::io::stdin().read_to_string(&mut input).unwrap();
        let config: serde_json::Value = serde_json::from_str(&input).unwrap();
        let get = |key: &str| config[key].as_str().unwrap();
        let path = Path::new(get("directory")); let source = Path::new(get("source"));
        fs::create_dir_all(path).unwrap();
        let stems = build(path, source, |src, dst| crate::speech_runtime::separate_song_audio_in(
            get("distro"), get("root"), Path::new(get("script")), src, dst)).unwrap();
        let vocals = stems.vocals(path).unwrap();
        let cues: Vec<crate::song_director::Cue> = serde_json::from_value(config["cues"].clone()).unwrap();
        crate::song_pcm::build(path, &vocals, &cues,
            |src, dst| crate::speech_runtime::decode_song_audio_in(get("distro"), src, dst)).unwrap();
        assert!(load(path, source).is_ok()); assert!(crate::song_pcm::load(path, &vocals, &cues).is_ok());
        assert!(crate::song_pcm::load(path, source, &cues).is_err());
        println!("{}", serde_json::json!({"frames":stems.frames,"vocals":vocals,"accompaniment":stems.accompaniment(path).unwrap(),"clips":cues.len()}));
    }
    #[test]
    fn separation_cache_requires_both_complete_stems_and_unchanged_source() {
        let path = std::env::temp_dir().join(format!("song-stems-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap(); let source = path.join("audio.mp3"); fs::write(&source, b"original song").unwrap();
        let cache = build(&path, &source, |_, output| {
            fs::write(output.join("separation.json"), r#"{"model":"htdemucs","frames":44100,"sample_rate":44100,"channels":2}"#).unwrap();
            for name in ["vocals.wav", "accompaniment.wav"] { fs::write(output.join(name), vec![0; 44100 * 4 + 44]).unwrap(); }
            Ok(())
        }).unwrap();
        assert!(load(&path, &source).is_ok());
        assert!(build(&path, &source, |_, _| panic!("must reuse cache")).is_ok());
        fs::write(cache.accompaniment(&path).unwrap(), b"truncated").unwrap(); assert!(load(&path, &source).is_err());
        assert!(build(&path, &source, |_, _| Err("model failed".into())).is_err());
        assert!(path.join("stems.json").is_file());
        fs::write(&source, b"changed song").unwrap(); assert!(load(&path, &source).is_err());
        fs::remove_dir_all(&path).unwrap();
    }
}
