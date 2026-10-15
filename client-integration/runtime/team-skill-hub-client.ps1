param([Parameter(ValueFromRemainingArguments=$true)][string[]]$RemainingArgs)
$ErrorActionPreference = 'Stop'
$Root = if ($env:TEAM_SKILL_HUB_CLIENT_ROOT) { $env:TEAM_SKILL_HUB_CLIENT_ROOT } else { Join-Path $HOME '.team-skill-hub' }
$SelfNext = "$PSCommandPath.next"
if (Test-Path $SelfNext) { try { Move-Item -Force $SelfNext $PSCommandPath } catch {} }
$Current = Join-Path $Root 'current'
if (-not (Test-Path $Current)) { throw 'Team Skill Hub client integration is not installed' }
$Version = (Get-Content -Raw $Current).Trim()
$Runtime = Join-Path $Root ("releases\v$Version\runtime\client-runtime.mjs")
if (-not (Test-Path $Runtime)) { throw "Team Skill Hub client runtime v$Version is missing" }
& node $Runtime @RemainingArgs
exit $LASTEXITCODE
