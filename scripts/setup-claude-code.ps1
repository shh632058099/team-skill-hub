param(
  [Parameter(Mandatory=$true)][string]$Url,
  [string]$ServerName = "teamSkillHub",
  [string]$ApiKeyEnv = "TEAM_SKILL_HUB_API_KEY",
  [switch]$SkipMcp
)

$ErrorActionPreference = "Stop"
if ($Url -notmatch '^https?://') { throw "URL must start with http:// or https://" }
if ($ServerName -notmatch '^[A-Za-z0-9_-]+$') { throw "Invalid server name" }
if ($ApiKeyEnv -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Invalid API key env name" }

function Convert-ToHashtable($Value) {
  if ($null -eq $Value) { return $null }
  if ($Value -is [System.Collections.IDictionary]) {
    $result = @{}
    foreach ($key in $Value.Keys) { $result[$key] = Convert-ToHashtable $Value[$key] }
    return $result
  }
  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $result = @{}
    foreach ($property in $Value.PSObject.Properties) {
      $result[$property.Name] = Convert-ToHashtable $property.Value
    }
    return $result
  }
  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    return @($Value | ForEach-Object { Convert-ToHashtable $_ })
  }
  return $Value
}

$mcpUrl = $Url.TrimEnd('/')
if (-not $mcpUrl.EndsWith('/mcp')) { $mcpUrl = $mcpUrl.TrimEnd('/') + '/mcp' }
$baseUrl = $mcpUrl.Substring(0, $mcpUrl.Length - 4)
$eventUrl = $baseUrl + '/client-events/claude-code'
$claudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$settingsFile = Join-Path $claudeDir 'settings.json'
$headerHelper = Join-Path $claudeDir 'team-skill-hub-mcp-headers.ps1'
New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null

$root = @{}
if (Test-Path $settingsFile) {
  try { $root = Convert-ToHashtable (Get-Content -Raw $settingsFile | ConvertFrom-Json) }
  catch { throw "Existing Claude settings.json is invalid JSON; leaving it unchanged." }
}
if (-not $root.ContainsKey('hooks')) { $root['hooks'] = @{} }

$handler = @{
  type = 'http'
  url = $eventUrl
  timeout = 2
  headers = @{ Authorization = ('Bearer $' + $ApiKeyEnv) }
  allowedEnvVars = @($ApiKeyEnv)
}

foreach ($event in @('SessionStart','UserPromptSubmit','PostToolUse','Stop','SessionEnd')) {
  $kept = @()
  foreach ($groupValue in @($root['hooks'][$event])) {
    if ($null -eq $groupValue) { continue }
    $group = Convert-ToHashtable $groupValue
    $handlers = @($group['hooks']) | Where-Object {
      -not ($_['type'] -eq 'http' -and [string]$_['url'] -like '*/client-events/claude-code*')
    }
    if ($handlers.Count -gt 0) {
      $copy = @{}
      foreach ($key in $group.Keys) { $copy[$key] = $group[$key] }
      $copy['hooks'] = @($handlers)
      $kept += ,$copy
    }
  }
  $kept += ,@{ hooks = @($handler) }
  $root['hooks'][$event] = @($kept)
}

$root | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 $settingsFile

$helperLines = @(
  '$ErrorActionPreference = "Stop"',
  ('$value = [Environment]::GetEnvironmentVariable("' + $ApiKeyEnv + '")'),
  '@{ Authorization = ("Bearer " + $value) } | ConvertTo-Json -Compress'
)
$helperLines | Set-Content -Encoding utf8 $headerHelper

if (-not $SkipMcp) {
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Warning "claude CLI not found; Hooks installed, MCP registration skipped."
  } else {
    try { & claude mcp remove $ServerName --scope user 2>$null | Out-Null } catch {}
    $helperCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $headerHelper + '"'
    $mcp = @{ type='http'; url=$mcpUrl; headersHelper=$helperCommand } | ConvertTo-Json -Compress
    & claude mcp add-json $ServerName $mcp --scope user
    if ($LASTEXITCODE -ne 0) { throw "claude mcp add-json failed" }
  }
}

Write-Host "Configured Claude Code hooks: $settingsFile"
Write-Host "Hook endpoint: $eventUrl"
Write-Host "MCP URL: $mcpUrl"
Write-Host "API key environment variable: $ApiKeyEnv"
Write-Host "Set that environment variable before starting Claude Code."
Write-Host "Verify with: claude mcp get $ServerName"
