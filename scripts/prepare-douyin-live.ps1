$ErrorActionPreference = 'Stop'
function Get-Sha256([string] $FilePath) {
  $stream = [IO.File]::OpenRead($FilePath)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$release = Get-Content -LiteralPath (Join-Path $workspace 'vendor\douyin-live\release.json') -Raw | ConvertFrom-Json
$destination = Join-Path $workspace 'src-tauri\resources\douyin-live'
$executable = Join-Path $destination 'douyinLive.exe'
$metadata = Join-Path $destination 'release.json'
if ((Test-Path -LiteralPath $executable) -and (Test-Path -LiteralPath $metadata) -and (Test-Path -LiteralPath (Join-Path $destination 'LICENSE'))) {
  $saved = Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json
  if ($saved.version -eq $release.version -and $saved.sha256 -eq $release.sha256 -and $saved.executable_sha256 -eq (Get-Sha256 $executable)) {
    Write-Host "douyinLive $($release.version) is ready."
    exit 0
  }
}
$cache = Join-Path $workspace '.build-tmp'
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$archive = Join-Path $cache $release.asset
if (-not (Test-Path -LiteralPath $archive) -or (Get-Sha256 $archive) -ne $release.sha256) {
  Write-Host "Downloading douyinLive $($release.version)..."
  Invoke-WebRequest -Uri $release.url -OutFile $archive -UseBasicParsing
}
if ((Get-Sha256 $archive) -ne $release.sha256) { throw 'douyinLive archive SHA-256 mismatch' }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  foreach ($name in @('douyinLive.exe', 'LICENSE')) {
    $entry = @($zip.Entries | Where-Object { $_.FullName -eq $name })
    if ($entry.Count -ne 1) { throw "douyinLive release is missing $name" }
    $target = Join-Path $destination $name
    $inputStream = $entry[0].Open()
    $outputStream = [IO.File]::Create($target + '.tmp')
    try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    Move-Item -LiteralPath ($target + '.tmp') -Destination $target -Force
  }
} finally { $zip.Dispose() }
$release | Add-Member -NotePropertyName executable_sha256 -NotePropertyValue (Get-Sha256 $executable)
[IO.File]::WriteAllText($metadata, ($release | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
& $executable --version
if ($LASTEXITCODE -ne 0) { throw 'douyinLive version check failed' }
Write-Host 'douyinLive and its MIT license are ready for the desktop bundle.'
