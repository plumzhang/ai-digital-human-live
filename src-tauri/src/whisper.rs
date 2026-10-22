use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, io::{BufRead, BufReader, Write}, path::{Path, PathBuf}, process::{Child, ChildStdin, Command, Stdio}, sync::{mpsc, Mutex}, time::Duration};
use tauri::Manager;

#[derive(Default)]
pub struct WhisperRuntime(Mutex<Option<Worker>>);

#[derive(Deserialize)]
struct RuntimeConfig { python: PathBuf, model: PathBuf, device: String, compute_type: String, library_directory: Option<PathBuf> }

struct Worker {
    child: Child,
    stdin: ChildStdin,
    responses: mpsc::Receiver<Result<Value, String>>,
    info: Value,
}

impl Drop for Worker {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}

impl Worker {
    fn start(directory: &Path) -> Result<Self, String> {
        let config: RuntimeConfig = serde_json::from_str(&fs::read_to_string(directory.join("runtime.json"))
            .map_err(|_| "Whisper 尚未安装，请运行 npm run setup:whisper".to_string())?).map_err(|e| format!("Whisper 配置无效：{e}"))?;
        if !config.python.is_file() || !config.model.join("model.bin").is_file() { return Err("Whisper 运行环境或模型文件缺失，请重新运行 npm run setup:whisper".into()); }
        if !["cpu", "cuda"].contains(&config.device.as_str()) || !["int8", "float16", "int8_float16"].contains(&config.compute_type.as_str()) { return Err("Whisper 计算配置无效".into()); }
        let script = directory.join("worker.py");
        fs::write(&script, include_str!("../../scripts/whisper_worker.py")).map_err(|e| e.to_string())?;
        let mut command = Command::new(&config.python);
        command.arg("-u").arg(&script).arg("--model").arg(&config.model)
            .arg("--device").arg(&config.device).arg("--compute-type").arg(&config.compute_type)
            .env("HF_HUB_OFFLINE", "1").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if let Some(directory) = &config.library_directory {
            if !directory.is_dir() { return Err("CUDA 动态库目录不存在，请重新配置 Whisper".into()); }
            let existing = std::env::var_os("PATH").unwrap_or_default();
            let paths = std::iter::once(directory.clone()).chain(std::env::split_paths(&existing));
            command.env("PATH", std::env::join_paths(paths).map_err(|e| e.to_string())?);
        }
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|e| format!("Whisper 启动失败：{e}"))?;
        let stdin = child.stdin.take().ok_or("Whisper 输入管道不可用")?;
        let stdout = child.stdout.take().ok_or("Whisper 输出管道不可用")?;
        let (sender, responses) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let value = line.map_err(|e| e.to_string()).and_then(|s| serde_json::from_str(&s).map_err(|e| format!("Whisper 返回格式错误：{e}")));
                if sender.send(value).is_err() { return; }
            }
            let _ = sender.send(Err("Whisper 进程已退出，请重新加载模型".into()));
        });
        let mut worker = Self { child, stdin, responses, info: Value::Null };
        worker.info = worker.read(Duration::from_secs(120))?;
        if worker.info["ready"] != true { return Err("Whisper 模型未就绪".into()); }
        Ok(worker)
    }
    fn read(&self, timeout: Duration) -> Result<Value, String> {
        let value = self.responses.recv_timeout(timeout).map_err(|_| "Whisper 响应超时或进程中断，请重新加载模型".to_string())??;
        if let Some(error) = value["error"].as_str() { return Err(format!("Whisper：{error}")); }
        Ok(value)
    }
    fn transcribe(&mut self, samples: &[i16]) -> Result<Value, String> {
        serde_json::to_writer(&mut self.stdin, &json!({"samples":samples})).map_err(|e| e.to_string())?;
        self.stdin.write_all(b"\n").and_then(|_| self.stdin.flush()).map_err(|e| e.to_string())?;
        self.read(Duration::from_secs(30))
    }
    fn transcribe_file(&mut self, path: &Path) -> Result<Value, String> {
        serde_json::to_writer(&mut self.stdin, &json!({"audio_path":path})).map_err(|e| e.to_string())?;
        self.stdin.write_all(b"\n").and_then(|_| self.stdin.flush()).map_err(|e| e.to_string())?;
        self.read(Duration::from_secs(1800))
    }
}

// Only called with an application-owned song file, never a renderer-supplied path.
pub async fn transcribe_song(app: tauri::AppHandle, path: PathBuf) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WhisperRuntime>();
        let mut guard = state.0.try_lock().map_err(|_| "语音识别正在使用中，请稍后生成歌曲导播".to_string())?;
        if guard.is_none() { *guard = Some(Worker::start(&runtime_directory(&app)?)?); }
        match guard.as_mut().unwrap().transcribe_file(&path) {
            Ok(value) => Ok(value),
            Err(error) => { *guard = None; Err(error) }
        }
    }).await.map_err(|e| e.to_string())?
}

fn runtime_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|p| p.join("whisper")).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn whisper_prepare(app: tauri::AppHandle, reload: Option<bool>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WhisperRuntime>();
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        if reload == Some(true) { *guard = None; }
        if guard.as_mut().is_some_and(|worker| worker.child.try_wait().ok().flatten().is_some()) { *guard = None; }
        if guard.is_none() { *guard = Some(Worker::start(&runtime_directory(&app)?)?); }
        Ok(guard.as_ref().unwrap().info.clone())
    }).await.map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
pub struct AudioRequest {
    live_id: String, task_id: String, capture_id: String,
    offset_ms: u64, captured_at: u64, samples: Vec<i16>,
}

fn validate(request: &AudioRequest) -> Result<(), String> {
    if [request.live_id.as_str(), request.task_id.as_str(), request.capture_id.as_str()].iter().any(|s| s.is_empty() || s.len() > 128) ||
        !(1600..=400000).contains(&request.samples.len()) || request.offset_ms > 3_600_000 || request.captured_at == 0 {
        return Err("无效的 Whisper 音频批次（需单声道16kHz PCM，0.1–25秒）".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn whisper_transcribe(app: tauri::AppHandle, request: AudioRequest) -> Result<Value, String> {
    validate(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WhisperRuntime>();
        // Never accumulate unbounded audio jobs behind a slow inference.
        let mut guard = state.0.try_lock().map_err(|_| "Whisper 正在处理另一批音频".to_string())?;
        let worker = guard.as_mut().ok_or("Whisper 尚未加载，请先加载模型")?;
        match worker.transcribe(&request.samples) {
            Ok(mut value) => {
                value["live_id"] = json!(request.live_id); value["task_id"] = json!(request.task_id);
                value["capture_id"] = json!(request.capture_id); value["offset_ms"] = json!(request.offset_ms);
                value["captured_at"] = json!(request.captured_at);
                value["enabled"] = json!(true);
                Ok(value)
            }
            Err(error) => { *guard = None; Err(error) }
        }
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires local Whisper and WHISPER_TEST_SONG pointing to 花落了一整个秋天"]
    fn local_song_recognition_keeps_the_verse_and_chorus_after_42_seconds() {
        let root = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap()).join("com.innotechx.digitalhuman.live/whisper");
        let mut worker = Worker::start(&root).unwrap();
        let result = worker.transcribe_file(Path::new(&std::env::var("WHISPER_TEST_SONG").unwrap())).unwrap();
        let segments = result["segments"].as_array().unwrap();
        assert!(segments.iter().any(|segment| segment["text"].as_str().unwrap_or("").contains("后来天空") && (42000..48000).contains(&segment["start_ms"].as_u64().unwrap())));
        assert!(segments.iter().any(|segment| segment["text"].as_str().unwrap_or("").contains("花落") && (65000..80000).contains(&segment["start_ms"].as_u64().unwrap())));
        assert!(segments.iter().filter(|segment| (42000..99900).contains(&segment["start_ms"].as_u64().unwrap())).count() >= 12);
        println!("song segments={}; inference_ms={}", segments.len(), result["inference_ms"]);
    }

    #[test]
    fn bounds_audio_and_requires_task_identity() {
        let mut request = AudioRequest { live_id:"live".into(), task_id:"task".into(), capture_id:"attempt".into(), offset_ms:0, captured_at:1, samples:vec![0; 1600] };
        assert!(validate(&request).is_ok());
        request.samples.resize(400001, 0); assert!(validate(&request).is_err());
        request.samples.truncate(1600); request.capture_id.clear(); assert!(validate(&request).is_err());
    }

    #[test]
    #[ignore = "requires npm run setup:whisper and WHISPER_TEST_PCM (16kHz mono signed little-endian PCM)"]
    fn local_worker_recognizes_real_chinese_audio_and_keeps_silence_empty() {
        let root = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap()).join("com.innotechx.digitalhuman.live").join("whisper");
        let mut worker = Worker::start(&root).unwrap();
        let bytes = fs::read(std::env::var("WHISPER_TEST_PCM").unwrap()).unwrap();
        assert_eq!(bytes.len() % 2, 0);
        let samples = bytes.chunks_exact(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]])).collect::<Vec<_>>();
        let result = worker.transcribe(&samples).unwrap();
        let text = result["segments"].as_array().unwrap().iter().map(|segment| segment["text"].as_str().unwrap_or("")).collect::<String>();
        println!("Whisper recognized: {text}; inference_ms={}", result["inference_ms"]);
        assert!(text.contains("直播间")); assert!(text.contains("晚安"));
        assert!(result["segments"][0]["words"].as_array().is_some_and(|words| !words.is_empty()));
        let silence = worker.transcribe(&vec![0; 16000]).unwrap();
        assert!(silence["segments"].as_array().unwrap().is_empty());
    }
}
