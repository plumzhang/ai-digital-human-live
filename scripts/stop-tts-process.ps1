param(
  [Parameter(Mandatory=$true)][string]$PythonPath,
  [Parameter(Mandatory=$true)][string]$RuntimeScript,
  [string]$SourceScript = '',
  [ValidateRange(1024,65535)][int]$Port = 8766
)
$ErrorActionPreference = 'Stop'
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) { Write-Output 'stopped'; exit 0 }
$serviceProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
$expectedPython = [IO.Path]::GetFullPath($PythonPath)
if (-not $serviceProcess -or -not [string]::Equals($serviceProcess.ExecutablePath, $expectedPython, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Port is owned by another application; no process was stopped.'
}
$scriptMatches = $false
foreach ($scriptPath in @($RuntimeScript, $SourceScript)) {
  if (-not $scriptPath) { continue }
  $expectedScript = [IO.Path]::GetFullPath($scriptPath)
  $commandLine = $serviceProcess.CommandLine.Replace([char]47, [char]92)
  if ($commandLine -match ('^\s*(?:"[^\"]+"|\S+)\s+(?:-u\s+)?(?:"' + [regex]::Escape($expectedScript) + '"|' + [regex]::Escape($expectedScript) + ')(?:\s|$)')) { $scriptMatches = $true }
}
if (-not $scriptMatches) { throw 'Python is running a different script; no process was stopped.' }
# Stop only the listener whose executable and exact script argument match our
# installed service. Never kill all Python processes or blindly kill by port.
$nativeProcess = Get-Process -Id $serviceProcess.ProcessId
Stop-Process -InputObject $nativeProcess -Force
if (-not $nativeProcess.WaitForExit(5000)) { throw 'TTS process did not exit.' }
Write-Output 'stopped'
