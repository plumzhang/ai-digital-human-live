$ErrorActionPreference = 'Stop'
$speechRoot = Join-Path $env:LOCALAPPDATA 'com.innotechx.digitalhuman.live\speech'
$configPath = Join-Path $speechRoot 'runtime.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Run npm run setup:speech first.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
# Migrate only an identified legacy service. Never kill an arbitrary port owner.
$health = $null
try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8766/health' -TimeoutSec 2 } catch {}
if ($health.model -like 'Qwen/*') {
    $oldRoot = Join-Path (Split-Path $speechRoot) 'qwen3-tts'
    $old = Get-Content -LiteralPath (Join-Path $oldRoot 'runtime.json') -Raw | ConvertFrom-Json
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'stop-tts-process.ps1') -PythonPath $old.python -RuntimeScript (Join-Path $oldRoot 'server.py') -SourceScript (Join-Path $PSScriptRoot 'qwen_tts_server.py')
    if ($LASTEXITCODE -ne 0) { throw 'Cannot close the identified legacy TTS service.' }
}
foreach ($name in @('speech_server.py','speech_control.py','funasr_worker.py')) {
    [IO.File]::WriteAllText((Join-Path $speechRoot $name), [IO.File]::ReadAllText((Join-Path $PSScriptRoot $name)).Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
}
$linuxScripts = (& wsl.exe -d $config.distro -u root --exec wslpath -u $speechRoot).Trim()
& wsl.exe -d $config.distro -u root --exec /usr/bin/python3 "$linuxScripts/speech_control.py" run --root $config.root --scripts $linuxScripts
if ($LASTEXITCODE -ne 0) { throw 'Speech service exited with an error.' }
