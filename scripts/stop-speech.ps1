$ErrorActionPreference = 'Stop'
$speechRoot = Join-Path $env:LOCALAPPDATA 'com.innotechx.digitalhuman.live\speech'
$configPath = Join-Path $speechRoot 'runtime.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Speech runtime is not installed.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$linuxScripts = (& wsl.exe -d $config.distro -u root --exec wslpath -u $speechRoot).Trim()
& wsl.exe -d $config.distro -u root --exec /usr/bin/python3 "$linuxScripts/speech_control.py" stop --root $config.root --scripts $linuxScripts
if ($LASTEXITCODE -ne 0) { throw 'Speech service stop failed.' }
Write-Host 'Speech service stopped.'
