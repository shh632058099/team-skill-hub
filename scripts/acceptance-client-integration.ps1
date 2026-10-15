param([switch]$RequireRealClis)
$ErrorActionPreference='Stop'
$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $Root
try {
  & node --import tsx --test tests/client-integration-release.test.ts tests/client-integration-build.test.ts tests/client-integration-runtime.test.ts tests/client-integration-session-start.test.ts tests/client-integration-updater.test.ts tests/client-integration-server.test.ts tests/client-integration-bootstrap.test.ts tests/client-integration-version-check.test.ts
  if($LASTEXITCODE -ne 0){throw 'Client integration fixture acceptance failed'}
  $Codex=Get-Command codex -ErrorAction SilentlyContinue
  $Claude=Get-Command claude -ErrorAction SilentlyContinue
  if($Codex -and $Claude){
    Write-Host 'Real Codex and Claude CLIs detected. Verify SessionStart notice rendering against a disposable/local Hub before release.'
  } elseif($RequireRealClis){
    throw 'RequireRealClis was requested but codex and/or claude is unavailable'
  } else {
    Write-Host 'Fixture acceptance passed; real Codex/Claude SessionStart acceptance skipped because the CLIs are not installed.'
  }
} finally { Pop-Location }
