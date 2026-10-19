$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe')) { $env:Path = "$cargoBin;$env:Path" }
Push-Location $workspace
try {
  if (-not (Test-Path -LiteralPath (Join-Path $workspace 'vendor\dyhub\dist\index.js'))) {
    npm run prepare:dyhub
    if ($LASTEXITCODE -ne 0) { throw 'Preparing dyhub failed' }
  }
  npm run tauri dev
  if ($LASTEXITCODE -ne 0) { throw 'Tauri development run failed' }
} finally { Pop-Location }
