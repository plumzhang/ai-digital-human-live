use crate::song_director::Cue;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const BYTES_PER_MS: u64 = 48;
#[derive(Serialize, Deserialize)]
pub(crate) struct SongPcm {
    revision: String,
    source_len: u64,
    source_modified: u128,
    #[serde(default)] source_name: String,
    cues: Vec<Cue>,
    sample_rate: u32,
    channels: u16,
    format: String,
}
fn stamp(source: &Path) -> Result<(u64, u128), String> {
    let metadata = fs::metadata(source).map_err(|e| e.to_string())?;
    Ok((
        metadata.len(),
        metadata
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos(),
    ))
}
fn clip_path(directory: &Path, revision: &str, index: usize) -> Result<PathBuf, String> {
    let revision = uuid::Uuid::parse_str(revision).map_err(|_| "歌词PCM版本无效")?;
    Ok(directory
        .join("pcm")
        .join(revision.to_string())
        .join(format!("segment-{index:04}.pcm")))
}
pub(crate) fn load(directory: &Path, source: &Path, cues: &[Cue]) -> Result<SongPcm, String> {
    let cache: SongPcm = serde_json::from_slice(
        &fs::read(directory.join("pcm.json")).map_err(|_| "请先按歌词时间轴截取PCM")?,
    )
    .map_err(|_| "歌词PCM清单无效，请重新截取")?;
    if cues.is_empty()
        || cache.sample_rate != 24000
        || cache.channels != 1
        || cache.format != "s16le"
    {
        return Err("歌词PCM格式无效，请重新截取".into());
    }
    let (len, modified) = stamp(source)?;
    let same_crops=cache.cues.len()==cues.len()&&cache.cues.iter().zip(cues).all(|(old,new)|old.start_ms==new.start_ms&&old.end_ms==new.end_ms&&old.text==new.text);
    if !same_crops || cache.source_name != source.file_name().unwrap_or_default().to_string_lossy() || cache.source_len != len || cache.source_modified != modified {
        return Err("原歌曲或歌词时间轴已变化，请重新截取PCM".into());
    }
    for (index, cue) in cues.iter().enumerate() {
        let len = fs::metadata(clip_path(directory, &cache.revision, index)?)
            .map_err(|_| "歌词PCM片段缺失，请重新截取")?
            .len();
        if len != (cue.end_ms - cue.start_ms) * BYTES_PER_MS {
            return Err("歌词PCM片段长度不匹配，请重新截取".into());
        }
    }
    Ok(cache)
}
impl SongPcm {
    pub(crate) fn segments(&self, directory: &Path) -> Result<serde_json::Value, String> {
        let parts=self.cues.iter().enumerate().map(|(index,cue)|Ok(serde_json::json!({"index":index,"start_ms":cue.start_ms,"end_ms":cue.end_ms,
            "sample_count":(cue.end_ms-cue.start_ms)*24,"pcm_path":clip_path(directory,&self.revision,index)?.to_string_lossy()}))).collect::<Result<Vec<_>,String>>()?;
        Ok(serde_json::json!(parts))
    }
}
fn remove_revision(directory: &Path, revision: &str) {
    if uuid::Uuid::parse_str(revision).is_err() {
        return;
    }
    let root = directory.join("pcm");
    let target = root.join(revision);
    if let (Ok(root), Ok(target)) = (root.canonicalize(), target.canonicalize()) {
        if target.parent() == Some(root.as_path()) {
            let _ = fs::remove_dir_all(target);
        }
    }
}
pub(crate) fn build(
    directory: &Path,
    source: &Path,
    cues: &[Cue],
    decode: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<SongPcm, String> {
    if let Ok(cache) = load(directory, source, cues) {
        return Ok(cache);
    }
    let total = cues
        .iter()
        .try_fold(0u64, |sum, cue| {
            sum.checked_add(cue.end_ms.saturating_sub(cue.start_ms))
        })
        .ok_or("歌词PCM总时长无效")?;
    if cues.is_empty()
        || cues.len() > 2000
        || total > 3_600_000
        || cues
            .iter()
            .any(|c| c.start_ms >= c.end_ms || c.end_ms > 1_800_000)
    {
        return Err("歌词PCM时间轴无效或总片段超过60分钟".into());
    }
    let before = stamp(source)?;
    let revision = uuid::Uuid::new_v4().to_string();
    let work = directory.join("pcm").join(&revision);
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let outcome = (|| {
        let full = work.join("source.pcm");
        decode(source, &full)?;
        let mut input = fs::File::open(&full).map_err(|e| e.to_string())?;
        let bytes = input.metadata().map_err(|e| e.to_string())?.len();
        if bytes == 0 || bytes % 2 != 0 || bytes > BYTES_PER_MS * 1_801_000 {
            return Err("原歌曲解码PCM格式或时长无效".into());
        }
        for (index, cue) in cues.iter().enumerate() {
            if cue.end_ms * BYTES_PER_MS > bytes {
                return Err(format!(
                    "第{}段歌词结束时间超出原歌曲实际音频，请调整时间轴",
                    index + 1
                ));
            }
            input
                .seek(SeekFrom::Start(cue.start_ms * BYTES_PER_MS))
                .map_err(|e| e.to_string())?;
            let mut output = fs::File::create(clip_path(directory, &revision, index)?)
                .map_err(|e| e.to_string())?;
            let length = (cue.end_ms - cue.start_ms) * BYTES_PER_MS;
            let copied = std::io::copy(&mut (&mut input).take(length), &mut output)
                .map_err(|e| e.to_string())?;
            output.flush().map_err(|e| e.to_string())?;
            if copied != length {
                return Err("歌词PCM截取不完整".into());
            }
        }
        if stamp(source)? != before {
            return Err("截取期间原歌曲发生变化，请重试".into());
        }
        fs::remove_file(full).map_err(|e| e.to_string())?;
        let cache = SongPcm {
            revision: revision.clone(),
            source_len: before.0,
            source_modified: before.1,
            source_name: source.file_name().unwrap_or_default().to_string_lossy().into_owned(),
            cues: cues.to_vec(),
            sample_rate: 24000,
            channels: 1,
            format: "s16le".into(),
        };
        crate::queue_store::atomic_write(
            directory,
            "pcm.json",
            &serde_json::to_string_pretty(&cache).map_err(|e| e.to_string())?,
        )?;
        Ok(cache)
    })();
    if outcome.is_err() {
        remove_revision(directory, &revision);
    } else if let Ok(entries) = fs::read_dir(directory.join("pcm")) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name != revision {
                    remove_revision(directory, name);
                }
            }
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, PathBuf, Vec<u8>, Vec<Cue>) {
        let directory = std::env::temp_dir().join(format!("song-pcm-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("audio.wav");
        fs::write(&source, b"original song").unwrap();
        let pcm = (0..72000).flat_map(|i| (i as i16).to_le_bytes()).collect();
        let cues = vec![
            Cue {
                start_ms: 100,
                end_ms: 205,
                text: "第一段".into(),
                lead_ms: 500,
            },
            Cue {
                start_ms: 1000,
                end_ms: 1999,
                text: "第二段".into(),
                lead_ms: 500,
            },
        ];
        (directory, source, pcm, cues)
    }
    #[test]
    fn clips_are_exact_original_sample_ranges_and_never_include_the_gap() {
        let (directory, source, pcm, cues) = fixture();
        let cache = build(&directory, &source, &cues, |_, out| {
            fs::write(out, &pcm).map_err(|e| e.to_string())
        })
        .unwrap();
        for (index, cue) in cues.iter().enumerate() {
            assert_eq!(
                fs::read(clip_path(&directory, &cache.revision, index).unwrap()).unwrap(),
                pcm[(cue.start_ms * 48) as usize..(cue.end_ms * 48) as usize]
            );
        }
        assert_eq!(fs::read(&source).unwrap(), b"original song");
        assert!(load(&directory, &source, &cues).is_ok());
        build(&directory, &source, &cues, |_, _| {
            panic!("unchanged crops must be reused")
        })
        .unwrap();
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn failed_crop_preserves_the_previous_cache_and_edits_invalidate_it() {
        let (directory, source, pcm, cues) = fixture();
        build(&directory, &source, &cues, |_, out| {
            fs::write(out, &pcm).map_err(|e| e.to_string())
        })
        .unwrap();
        let manifest = fs::read(directory.join("pcm.json")).unwrap();
        let mut edited = cues.clone();
        edited[1].end_ms = 4000;
        assert!(
            build(&directory, &source, &edited, |_, out| fs::write(out, &pcm)
                .map_err(|e| e.to_string()))
            .is_err()
        );
        assert_eq!(fs::read(directory.join("pcm.json")).unwrap(), manifest);
        assert!(load(&directory, &source, &cues).is_ok());
        edited[1].end_ms = 2000;
        assert!(load(&directory, &source, &edited).is_err());
        fs::write(&source, b"changed original").unwrap();
        assert!(load(&directory, &source, &cues).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    #[ignore = "reads local source/cues/WSL distro from stdin; decodes and crops a copy of real song audio without Vidu"]
    fn local_real_song_clips() {
        #[derive(Deserialize)]
        struct Probe {
            source: PathBuf,
            cues: Vec<Cue>,
            distro: String,
            output: PathBuf,
        }
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text).unwrap();
        let config: Probe = serde_json::from_str(&text).unwrap();
        let directory = config.output.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("original.audio");
        fs::copy(&config.source, &source).unwrap();
        let begin = std::time::Instant::now();
        let cache = build(&directory, &source, &config.cues, |src, dst| {
            crate::speech_runtime::decode_song_audio_in(&config.distro, src, dst)
        })
        .unwrap();
        println!(
            "{}",
            serde_json::json!({"clips":config.cues.len(),"elapsed_ms":begin.elapsed().as_millis(),"directory":directory,"first":cache.segments(&directory).unwrap()[0]})
        );
    }
}
