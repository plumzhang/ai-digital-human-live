param(
  [ValidateSet('tiny', 'base', 'small', 'medium', 'large-v3', 'turbo')][string]$Model = 'small',
  [ValidateSet('cpu', 'cuda')][string]$Device = 'cpu',
  [string]$CudaLibraryDirectory = '',
  [string]$RuntimeDirectory = (Join-Path $env:LOCALAPPDATA 'com.innotechx.digitalhuman.live\whisper')
)
$ErrorActionPreference = 'Stop'
$runtime = [IO.Path]::GetFullPath($RuntimeDirectory)
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$pythonDirectory = Join-Path $runtime 'python'
$python = Join-Path $pythonDirectory 'python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  $archive = Join-Path $runtime 'python-3.12.10-embed-amd64.zip'
  Invoke-WebRequest 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip' -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $pythonDirectory -Force
  $pth = Join-Path $pythonDirectory 'python312._pth'
  [IO.File]::WriteAllText($pth, "python312.zip`n.`nLib/site-packages`nimport site`n", [Text.UTF8Encoding]::new($false))
}
if (-not (Test-Path -LiteralPath (Join-Path $pythonDirectory 'Lib\site-packages\pip'))) {
  $bootstrap = Join-Path $runtime 'get-pip.py'
  Invoke-WebRequest 'https://bootstrap.pypa.io/get-pip.py' -OutFile $bootstrap
  & $python $bootstrap --disable-pip-version-check
  if ($LASTEXITCODE -ne 0) { throw 'Installing pip failed' }
}
& $python -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'whisper-requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Installing Whisper dependencies failed' }
$modelDirectory = Join-Path $runtime "models\$Model"
& node (Join-Path $PSScriptRoot 'download-whisper-model.mjs') $Model $modelDirectory
if ($LASTEXITCODE -ne 0) { throw 'Downloading the Whisper model failed; rerun this script to resume' }
$compute = if ($Device -eq 'cuda') { 'float16' } else { 'int8' }
if ($CudaLibraryDirectory) {
  $CudaLibraryDirectory = [IO.Path]::GetFullPath($CudaLibraryDirectory)
  if (-not (Test-Path -LiteralPath $CudaLibraryDirectory -PathType Container)) { throw 'CUDA library directory does not exist' }
  $env:Path = "$CudaLibraryDirectory;$env:Path"
}
& $python -c 'import sys, numpy as np; from faster_whisper import WhisperModel; model=WhisperModel(sys.argv[1], device=sys.argv[2], compute_type=sys.argv[3], local_files_only=True); list(model.transcribe(np.zeros(16000, dtype=np.float32), language="zh", beam_size=1, condition_on_previous_text=False, vad_filter=False)[0]); print("Whisper model loaded and inference verified")' $modelDirectory $Device $compute
if ($LASTEXITCODE -ne 0) { throw 'Whisper could not load; CUDA requires cuBLAS 12 and cuDNN 9 on PATH. Try -Device cpu.' }
$config = @{ python = $python; model = $modelDirectory; device = $Device; compute_type = $compute }
if ($CudaLibraryDirectory) { $config.library_directory = $CudaLibraryDirectory }
[IO.File]::WriteAllText((Join-Path $runtime 'runtime.json'), ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output "Whisper ready: $Model ($Device / $compute), $runtime"
