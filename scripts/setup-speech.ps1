param([string]$Distribution = 'InnoTechx-Speech', [string]$HfEndpoint = 'https://hf-mirror.com', [ValidateSet('modelscope','huggingface')][string]$ModelSource = 'modelscope', [switch]$PrecompiledCache)
$ErrorActionPreference = 'Stop'
$speechRoot = Join-Path $env:LOCALAPPDATA 'com.innotechx.digitalhuman.live\speech'
New-Item -ItemType Directory -Force -Path $speechRoot | Out-Null
if ($Distribution -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$') { throw 'Invalid distribution name' }
$distros = ((& wsl.exe --list --quiet) -join "`n") -replace "`0", ''
if ($distros -notmatch "(?m)^$([regex]::Escape($Distribution))\s*$") {
    $base = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/current'
    $filename = 'ubuntu-noble-wsl-amd64-24.04lts.rootfs.tar.gz'
    $archive = Join-Path $speechRoot 'ubuntu-noble.tar.gz'
    $sumsPath = Join-Path $speechRoot 'SHA256SUMS'
    & curl.exe --fail --location --retry 3 --output $sumsPath "$base/SHA256SUMS"
    if ($LASTEXITCODE -ne 0) { throw 'Unable to download Ubuntu checksums' }
    $expected = ([regex]::Match((Get-Content -LiteralPath $sumsPath -Raw), "(?m)^([a-f0-9]{64})\s+\*?$([regex]::Escape($filename))\s*$")).Groups[1].Value
    if (-not $expected) { throw 'Ubuntu rootfs checksum not published' }
    if (-not (Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) {
        & curl.exe --fail --location --retry 3 --output $archive "$base/$filename"
        if ($LASTEXITCODE -ne 0) { throw 'Ubuntu download failed' }
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'Ubuntu SHA256 mismatch' }
    & wsl.exe --import $Distribution (Join-Path $speechRoot 'wsl-managed') $archive --version 2
    if ($LASTEXITCODE -ne 0) { throw 'WSL2 import failed. Install/enable WSL2, then rerun setup:speech.' }
}
foreach ($name in @('speech_server.py','speech_control.py','funasr_worker.py','download-speech-models.py','setup-speech-wsl.sh')) {
    # UTF-8 without BOM and Linux newlines, including when checked out with CRLF.
    $source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $name)).Replace("`r`n", "`n")
    [IO.File]::WriteAllText((Join-Path $speechRoot $name), $source, [Text.UTF8Encoding]::new($false))
}
$linuxScripts = (& wsl.exe -d $Distribution -u root --exec wslpath -u $speechRoot).Trim()
if ($LASTEXITCODE -ne 0) { throw 'WSL path mapping failed' }
if ($HfEndpoint -notin @('https://hf-mirror.com', 'https://huggingface.co')) { throw 'Use the official Hugging Face endpoint or the upstream-recommended hf-mirror.com.' }
& wsl.exe -d $Distribution -u root --exec env "HF_ENDPOINT=$HfEndpoint" "SPEECH_MODEL_SOURCE=$ModelSource" "SPEECH_PRECOMPILED_CACHE=$([int]$PrecompiledCache.IsPresent)" bash "$linuxScripts/setup-speech-wsl.sh" $linuxScripts
if ($LASTEXITCODE -ne 0) { throw 'Speech setup failed; runtime configuration was not activated.' }
$runtime = @{ schema = 1; backend = 'omnivoice-funasr-wsl2'; distro = $Distribution; root = '/opt/innotechx-speech'; model = 'k2-fsa/OmniVoice' }
[IO.File]::WriteAllText((Join-Path $speechRoot 'runtime.json'), ($runtime | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$oldVoice = Join-Path (Split-Path $speechRoot) 'qwen3-tts\voice.json'
if (-not (Test-Path -LiteralPath "$speechRoot\voice.json") -and (Test-Path -LiteralPath $oldVoice)) { Copy-Item -LiteralPath $oldVoice -Destination "$speechRoot\voice.json" }
Write-Host 'FunASR + OmniVoice installed. Run npm run start:speech or start it in the app.'
