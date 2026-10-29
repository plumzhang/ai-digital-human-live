# Compatibility entry point for older checkout instructions.
& (Join-Path $PSScriptRoot 'prepare-douyin-live.ps1')
exit $LASTEXITCODE
