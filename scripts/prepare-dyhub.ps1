$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $workspace 'vendor\dyhub'
$resources = Join-Path $workspace 'src-tauri\resources'
$destination = Join-Path $resources 'dyhub'
if (-not (Test-Path -LiteralPath (Join-Path $source 'package.json'))) { throw 'vendor/dyhub is missing' }
Push-Location $source
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw 'dyhub npm ci failed' }
  npx tsc -p tsconfig.json
  if ($LASTEXITCODE -ne 0) { throw 'dyhub TypeScript build failed' }
  $distUi = Join-Path $source 'dist\ui'
  if (Test-Path -LiteralPath $distUi) { Remove-Item -LiteralPath $distUi -Recurse -Force }
  Copy-Item -LiteralPath (Join-Path $source 'src\ui') -Destination $distUi -Recurse
} finally { Pop-Location }
$resolvedResources = [System.IO.Path]::GetFullPath($resources)
$resolvedDestination = [System.IO.Path]::GetFullPath($destination)
if (-not $resolvedDestination.StartsWith($resolvedResources + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Resource target escaped workspace' }
New-Item -ItemType Directory -Path $resources -Force | Out-Null
if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($name in @('dist', 'node_modules', 'third_party')) {
  Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $destination $name) -Recurse
}
Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination $destination
Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination $destination
$nodeBinary = (Get-Command node.exe).Source
Copy-Item -LiteralPath $nodeBinary -Destination (Join-Path $resources 'node.exe')
Write-Host 'dyhub and Node runtime are ready for the Tauri bundle.'
