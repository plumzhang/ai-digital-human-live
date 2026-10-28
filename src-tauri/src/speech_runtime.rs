use crate::component::{endpoint, TtsConfig};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, process::{Child, Command}, sync::{Mutex, atomic::{AtomicU64, Ordering}}, time::Duration};
use tauri::{Emitter, Manager};

pub const LOCAL_URL: &str = "http://127.0.0.1:8766";
pub const MODEL: &str = "k2-fsa/OmniVoice";
#[derive(Clone, Deserialize)]
struct Config { schema: u32, backend: String, distro: String, root: String, model: String }
struct LocalProcess { child: Child, generation: u64, config: Config, scripts: String }
#[derive(Default)]
pub struct LocalTtsRuntime { process: Mutex<Option<LocalProcess>>, operations: tokio::sync::Mutex<()>, generation: AtomicU64 }

fn quiet(command: &mut Command) {
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
}
fn command(config: &Config, scripts: &str, action: &str) -> Command {
    let mut command = Command::new("wsl.exe");
    command.args(["-d", &config.distro, "-u", "root", "--exec", "/usr/bin/python3", &format!("{scripts}/speech_control.py"), action,
        "--root", &config.root, "--scripts", scripts]);
    quiet(&mut command); command
}
impl Drop for LocalTtsRuntime {
    fn drop(&mut self) {
        if let Ok(guard) = self.process.get_mut() {
            if let Some(worker) = guard.as_mut() {
                // Killing the Windows wsl.exe handle alone leaves Linux GPU processes alive.
                let _ = command(&worker.config, &worker.scripts, "stop").output();
                let _ = worker.child.kill(); let _ = worker.child.wait();
            }
        }
    }
}
fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|p| p.join("speech")).map_err(|e| e.to_string())
}
fn read_config(path: &Path) -> Result<Config, String> {
    let config: Config = serde_json::from_str(&std::fs::read_to_string(path.join("runtime.json")).map_err(|_| "请先运行 npm run setup:speech 安装 WSL2 FunASR / OmniVoice 环境")?).map_err(|_| "语音服务运行配置无效")?;
    if config.schema != 1 || config.backend != "omnivoice-funasr-wsl2" || config.model != MODEL || !config.root.starts_with('/') || config.distro.is_empty() {
        return Err("语音服务运行配置不匹配，请重新运行 npm run setup:speech".into());
    }
    Ok(config)
}
fn require_local(tts: &TtsConfig) -> Result<(), String> {
    if tts.base_url.trim().trim_end_matches('/') != LOCAL_URL { return Err(format!("服务启停仅支持本机 {LOCAL_URL}")); }
    if tts.model != MODEL { return Err("本地服务使用 k2-fsa/OmniVoice，请保存新的语音配置".into()); }
    Ok(())
}
pub(crate) async fn service_health(tts: &TtsConfig) -> Result<Value, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
    client.get(endpoint(&tts.base_url, "health")?).bearer_auth(&tts.key).send().await.map_err(|_| "语音服务未响应")?
        .error_for_status().map_err(|_| "健康检查失败")?.json().await.map_err(|_| "健康检查格式无效".into())
}
pub(crate) fn validate_health(data: &Value) -> Result<(), String> {
    if let Some(error) = data["error"].as_str() { return Err(format!("语音服务初始化失败：{error}")); }
    if data["backend"] != "omnivoice-funasr-wsl2" || data["model"] != MODEL {
        return Err("本机端口运行的仍是旧服务，请关闭后启动 FunASR / OmniVoice 服务".into());
    }
    if data["ready"] != true || data["stt"]["ready"] != true { return Err("FunASR / OmniVoice 模型尚未就绪".into()); }
    if data["acceleration"]["flashinfer"] != true || data["acceleration"]["cuda_graph"] != true || data["acceleration"]["verified"] != true {
        return Err("OmniVoice FlashInfer / CUDA Graph 尚未通过实际推理验证".into());
    }
    Ok(())
}
fn emit(app: &tauri::AppHandle, state: &str) { let _ = app.emit("tts-service-state", json!({"state":state,"running_model":MODEL})); }
fn tracked(runtime: &LocalTtsRuntime) -> Result<Option<u64>, String> {
    let mut guard = runtime.process.lock().map_err(|e| e.to_string())?;
    if let Some(worker) = guard.as_mut() { if worker.child.try_wait().map_err(|e| e.to_string())?.is_some() { guard.take(); } }
    Ok(guard.as_ref().map(|p| p.generation))
}
fn deploy(path: &Path) -> Result<String, String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    for (file, source) in [("speech_control.py", include_str!("../../scripts/speech_control.py")), ("speech_server.py", include_str!("../../scripts/speech_server.py")), ("funasr_worker.py", include_str!("../../scripts/funasr_worker.py"))] {
        std::fs::write(path.join(file), source.replace("\r\n", "\n")).map_err(|e| e.to_string())?;
    }
    windows_to_wsl(path)
}
fn windows_to_wsl(path: &Path) -> Result<String, String> {
    let value = path.to_str().ok_or("语音服务目录编码无效")?;
    let bytes = value.as_bytes();
    if bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/') {
        return Ok(format!("/mnt/{}/{}", (bytes[0] as char).to_ascii_lowercase(), value[3..].replace('\\', "/")));
    }
    Err("WSL2 语音服务目录必须位于本机盘符路径".into())
}
async fn stop(app: &tauri::AppHandle, runtime: &LocalTtsRuntime) -> Result<(), String> {
    runtime.generation.fetch_add(1, Ordering::AcqRel);
    let legacy_running = service_health(&TtsConfig { base_url:LOCAL_URL.into(),key:String::new(),model:MODEL.into(),ref_audio:String::new(),ref_text:String::new() }).await.ok()
        .is_some_and(|v| v["model"].as_str().is_some_and(|model| model.starts_with("Qwen/")));
    let path = directory(app)?;
    let owned_config = runtime.process.lock().map_err(|e| e.to_string())?.as_ref().map(|worker| worker.config.clone());
    let config = owned_config.or_else(|| read_config(&path).ok());
    // Can also close a terminal-started instance identified by the Linux pid/starttime/cmdline.
    if let Some(config) = config {
        let scripts = deploy(&path)?;
        let output = tauri::async_runtime::spawn_blocking(move || command(&config, &scripts, "stop").output()).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        if !output.status.success() { return Err(format!("WSL2 服务关闭失败：{}", String::from_utf8_lossy(&output.stderr))); }
    }
    {
        let mut guard = runtime.process.lock().map_err(|e| e.to_string())?;
        if let Some(worker) = guard.as_mut() { let _ = worker.child.kill(); let _ = worker.child.wait(); }
        guard.take();
    }
    // One-time migration: only stop the exact legacy Python+script, never another listener.
    let legacy = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("qwen3-tts");
    if let Some(raw) = std::fs::read_to_string(legacy.join("runtime.json")).ok().filter(|_| legacy_running) {
        let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if let Some(python) = value["python"].as_str() {
            let helper = path.join("stop-legacy.ps1");
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            std::fs::write(&helper, include_str!("../../scripts/stop-tts-process.ps1")).map_err(|e| e.to_string())?;
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]).arg(helper).arg("-PythonPath").arg(python)
                .arg("-RuntimeScript").arg(legacy.join("server.py")).arg("-SourceScript").arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/qwen_tts_server.py"));
            quiet(&mut command);
            let output = tauri::async_runtime::spawn_blocking(move || command.output()).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
            if !output.status.success() { return Err("8766端口的进程不属于本软件，未停止该进程。请检查服务地址和端口。".into()); }
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn component_local_status(app: tauri::AppHandle, tts: TtsConfig) -> Result<Value, String> {
    let installed = read_config(&directory(&app)?).is_ok();
    let runtime = app.state::<LocalTtsRuntime>();
    let owned = tts.base_url.trim().trim_end_matches('/') == LOCAL_URL && tracked(&runtime)?.is_some();
    let info = service_health(&tts).await.ok();
    let state = if info.as_ref().is_some_and(|v| v["error"].is_string()) { "error" }
        else if info.as_ref().is_some_and(|v| validate_health(v).is_ok()) { "ready" }
        else if owned || info.as_ref().is_some_and(|v| v["backend"] == "omnivoice-funasr-wsl2") { "starting" }
        else if info.is_some() { "error" } else { "stopped" };
    Ok(json!({"state":state,"running_model":info.as_ref().and_then(|v| v.get("model")), "device":info.as_ref().and_then(|v| v.get("device")),
        "acceleration":info.as_ref().and_then(|v| v.get("acceleration")),"stt":info.as_ref().and_then(|v| v.get("stt")),
        "error":info.as_ref().and_then(|v| v.get("error")),"managed":owned,"installed_models":if installed {vec![MODEL]} else {vec![]}}))
}
#[tauri::command]
pub async fn component_stop_local(app: tauri::AppHandle, tts: TtsConfig) -> Result<Value, String> {
    require_local(&tts)?;
    let runtime = app.state::<LocalTtsRuntime>();
    let _operation = runtime.operations.lock().await;
    emit(&app, "stopping"); crate::component::cancel_live_speech(&app)?;
    if let Err(error) = stop(&app, &runtime).await { emit(&app, "error"); return Err(error); }
    if service_health(&tts).await.is_ok() { emit(&app, "error"); return Err("关闭后8766端口仍有服务响应，请检查服务日志".into()); }
    emit(&app, "stopped"); Ok(json!({"state":"stopped"}))
}
#[tauri::command]
pub async fn component_start_local(app: tauri::AppHandle, tts: TtsConfig) -> Result<Value, String> {
    require_local(&tts)?;
    let path = directory(&app)?;
    let config = read_config(&path)?;
    let runtime = app.state::<LocalTtsRuntime>();
    let generation;
    {
        let _operation = runtime.operations.lock().await;
        let health = service_health(&tts).await.ok();
        if let Some(info) = health.as_ref().filter(|info| validate_health(info).is_ok()) { return Ok(info.clone()); }
        if let Some(existing) = tracked(&runtime)?.filter(|_| !health.as_ref().is_some_and(|v| v["error"].is_string())) { generation = existing; }
        else {
            // A previous terminal instance or legacy Qwen service may own the port.
            stop(&app, &runtime).await?;
            crate::component::cancel_live_speech(&app)?;
            let scripts = deploy(&path)?;
            let log = std::fs::File::create(path.join("server.log")).map_err(|e| e.to_string())?;
            let child = command(&config, &scripts, "run").stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log).spawn().map_err(|e| format!("WSL2 语音服务启动失败：{e}"))?;
            generation = runtime.generation.fetch_add(1, Ordering::AcqRel) + 1;
            *runtime.process.lock().map_err(|e| e.to_string())? = Some(LocalProcess { child, generation, config, scripts });
            emit(&app, "starting");
        }
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
    while tokio::time::Instant::now() < deadline {
        if runtime.generation.load(Ordering::Acquire) != generation { return Err("语音服务启动已取消".into()); }
        if let Ok(info) = service_health(&tts).await {
            if runtime.generation.load(Ordering::Acquire) != generation { return Err("语音服务启动已取消".into()); }
            if info["error"].is_string() { emit(&app, "error"); return Err(format!("语音服务初始化失败：{}，日志：{}", info["error"], path.join("server.log").display())); }
            if validate_health(&info).is_ok() { emit(&app, "ready"); return Ok(info); }
        }
        if tracked(&runtime)?.is_none() { emit(&app, "stopped"); return Err(format!("语音服务已退出，请检查 {}", path.join("server.log").display())); }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Err("模型加载 / FlashInfer 预热超过10分钟，可检查状态或关闭服务后重试".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_reference_service_path_preserves_spaces_and_unicode() {
        assert_eq!(windows_to_wsl(Path::new("C:\\Users\\中文 名\\speech")).unwrap(), "/mnt/c/Users/中文 名/speech");
        assert!(windows_to_wsl(Path::new("\\\\host\\share")).is_err());
    }
    #[test]
    fn health_requires_both_models_and_verified_acceleration() {
        let mut v = json!({"ready":true,"backend":"omnivoice-funasr-wsl2","model":MODEL,"stt":{"ready":true},"acceleration":{"flashinfer":true,"cuda_graph":true,"verified":true}});
        assert!(validate_health(&v).is_ok());
        v["acceleration"]["verified"] = json!(false); assert!(validate_health(&v).is_err());
        v["acceleration"]["verified"] = json!(true); v["stt"]["ready"] = json!(false); assert!(validate_health(&v).is_err());
    }
}
