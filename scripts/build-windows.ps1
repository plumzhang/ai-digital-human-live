$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe')) { $env:Path = "$cargoBin;$env:Path" }
$temporary = Join-Path $workspace '.build-tmp'
New-Item -ItemType Directory -Path $temporary -Force | Out-Null
$env:TEMP = $temporary
$env:TMP = $temporary
Push-Location $workspace
try {
  npm run prepare:dyhub
  if ($LASTEXITCODE -ne 0) { throw 'Preparing dyhub failed' }
  npm run tauri build
  if ($LASTEXITCODE -ne 0) { throw 'Tauri build failed' }
} finally { Pop-Location }
