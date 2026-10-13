param(
  [string]$Url,
  [string]$ServerName = "teamSkillHub",
  [string]$ApiKeyEnv = "TEAM_SKILL_HUB_API_KEY",
  [switch]$SkipMcp,
  [switch]$AutoKnowledge,
  [switch]$NoAutoKnowledge,
  [switch]$Upgrade
)

$ErrorActionPreference = "Stop"

$ClaudeBegin = "<!-- BEGIN TEAM-SKILL-HUB -->"
$ClaudeEnd = "<!-- END TEAM-SKILL-HUB -->"
$HookRuntimeVersion = "1.1.0"
$HookSchemaVersion = "1"

$ServerNameExplicit = $PSBoundParameters.ContainsKey("ServerName")
$ApiKeyEnvExplicit = $PSBoundParameters.ContainsKey("ApiKeyEnv")

$ClaudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$SettingsFile = Join-Path $ClaudeDir 'settings.json'
$ClaudeMd = Join-Path $ClaudeDir 'CLAUDE.md'
$HooksDir = Join-Path $ClaudeDir 'hooks'
$HookConf = Join-Path $HooksDir 'team-skill-hub.conf'
$StopGate = Join-Path $HooksDir 'team-skill-hub-claude-stop.sh'

if ($Upgrade.IsPresent -and (Test-Path $HookConf)) {
    $Existing = @{}
    Get-Content $HookConf | ForEach-Object {
        $parts = $_ -split "=", 2
        if ($parts.Count -eq 2) { $Existing[$parts[0]] = $parts[1] }
    }
    if ([string]::IsNullOrWhiteSpace($Url)) {
        if ($Existing["mcp_url"]) { $Url = [string]$Existing["mcp_url"] }
        elseif ($Existing["event_url"]) { $Url = ([string]$Existing["event_url"] -replace '/client-events/claude-code/?$', '') + "/mcp" }
    }
    if (-not $ServerNameExplicit -and $Existing["server_name"]) { $ServerName = [string]$Existing["server_name"] }
    if (-not $ApiKeyEnvExplicit -and $Existing["api_key_env"]) { $ApiKeyEnv = [string]$Existing["api_key_env"] }
}

if ([string]::IsNullOrWhiteSpace($Url)) { $Url = Read-Host "Team Skill Hub MCP URL" }
if ($Url -notmatch '^https?://') { throw "URL must start with http:// or https://" }
if ($ServerName -notmatch '^[A-Za-z0-9_-]+$') { throw "Invalid server name" }
if ($ApiKeyEnv -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Invalid API key env name" }

$McpUrl = $Url.TrimEnd('/')
if (-not $McpUrl.EndsWith('/mcp')) { $McpUrl = $McpUrl.TrimEnd('/') + '/mcp' }
$BaseUrl = $McpUrl.Substring(0, $McpUrl.Length - 4)
$EventUrl = $BaseUrl + '/client-events/claude-code'

$AutoKnowledgeValue = if ($NoAutoKnowledge.IsPresent) { "false" } elseif ($AutoKnowledge.IsPresent) { "true" } elseif ($Upgrade.IsPresent -and (Test-Path $HookConf) -and $Existing["capture_stop_message"]) { [string]$Existing["capture_stop_message"] } else { "true" }

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

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Replace-ManagedBlock {
  param([string]$Content, [string]$Begin, [string]$End, [string]$Block)
  $pattern = "(?ms)^" + [regex]::Escape($Begin) + ".*?^" + [regex]::Escape($End) + "\r?\n?"
  if ([regex]::IsMatch($Content, $pattern)) {
    return [regex]::Replace($Content, $pattern, $Block + [Environment]::NewLine)
  }
  $trimmed = $Content.TrimEnd()
  if ($trimmed.Length -gt 0) {
    return $trimmed + [Environment]::NewLine + [Environment]::NewLine + $Block + [Environment]::NewLine
  }
  return $Block + [Environment]::NewLine
}

New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null
New-Item -ItemType Directory -Force -Path $HooksDir | Out-Null
if (-not (Test-Path $SettingsFile)) { New-Item -ItemType File -Path $SettingsFile | Out-Null }
if (-not (Test-Path $ClaudeMd)) { New-Item -ItemType File -Path $ClaudeMd | Out-Null }

$root = @{}
if ((Get-Item $SettingsFile).Length -gt 0) {
  try { $root = Convert-ToHashtable (Get-Content -Raw $SettingsFile | ConvertFrom-Json) }
  catch { throw "Existing Claude settings.json is invalid JSON; leaving it unchanged." }
}
if (-not $root.ContainsKey('hooks')) { $root['hooks'] = @{} }

$httpHandler = @{
  type = 'http'
  url = $EventUrl
  timeout = 2
  headers = @{ Authorization = ('Bearer ${' + $ApiKeyEnv + '}') }
  allowedEnvVars = @($ApiKeyEnv)
}
$stopHandler = @{
  type = 'command'
  command = 'bash "$HOME/.claude/hooks/team-skill-hub-claude-stop.sh"'
  timeout = 4
}

foreach ($event in @('SessionStart','UserPromptSubmit','PostToolUse','SessionEnd')) {
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
  $kept += ,@{ hooks = @($httpHandler) }
  $root['hooks'][$event] = @($kept)
}

$kept = @()
foreach ($groupValue in @($root['hooks']['Stop'])) {
  if ($null -eq $groupValue) { continue }
  $group = Convert-ToHashtable $groupValue
  $handlers = @($group['hooks']) | Where-Object {
    -not ([string]$_['command'] -like '*team-skill-hub-claude-stop*')
  }
  if ($handlers.Count -gt 0) {
    $copy = @{}
    foreach ($key in $group.Keys) { $copy[$key] = $group[$key] }
    $copy['hooks'] = @($handlers)
    $kept += ,$copy
  }
}
$kept += ,@{ hooks = @($stopHandler) }
$root['hooks']['Stop'] = @($kept)

$json = $root | ConvertTo-Json -Depth 20
Write-Utf8NoBom -Path $SettingsFile -Content $json

Copy-Item -Force (Join-Path $PSScriptRoot "team-skill-hub-claude-stop.sh") $StopGate

$confContent = "event_url=$EventUrl" + [Environment]::NewLine +
  "mcp_url=$McpUrl" + [Environment]::NewLine +
  "server_name=$ServerName" + [Environment]::NewLine +
  "api_key_env=$ApiKeyEnv" + [Environment]::NewLine +
  "capture_stop_message=$AutoKnowledgeValue" + [Environment]::NewLine +
  "runtime_version=$HookRuntimeVersion" + [Environment]::NewLine +
  "hook_schema_version=$HookSchemaVersion" + [Environment]::NewLine
Write-Utf8NoBom -Path $HookConf -Content $confContent

$ClaudeBlock = @(
    $ClaudeBegin,
    "## Team Skill Hub",
    "",
    "Use the ``$ServerName`` MCP server proactively for team-specific engineering work.",
    "",
    "For team-specific engineering tasks and questions, including short questions containing project or technology keywords:",
    "1. Before implementing, reviewing, diagnosing, or answering, call ``discover`` with the user's original request or its important terms; do not wait for the user to explicitly request Team Skill Hub, name a Skill, or ask for Knowledge.",
    "2. Treat ``discover`` as the default routing entry point. Let Skills, Knowledge, Prompts, Agents, and Tools compete by relevance instead of pre-classifying every request on the client.",
    "3. If ``discover`` returns a clearly relevant Skill, call ``get_skill`` before executing the task. If it returns clearly relevant Knowledge, call ``get_knowledge`` before answering or changing code. Load Prompts, Agents, or Tools only when they are actually relevant.",
    "4. Use ``resolve_skill``, ``search_skills``, ``search_knowledge``, or other asset-specific search tools only when ``discover`` is ambiguous, insufficient, or a more precise follow-up search is needed. Do not run Skill and Knowledge searches in parallel by default.",
    "5. Load only the selected assets; do not load every candidate. If no relevant Team Skill Hub asset is found, continue normally and do not invent team-specific guidance.",
    "6. Respect repository visibility, role filtering, and client compatibility.",
    "7. If a retrieved Team Skill Hub asset is clearly outdated or incorrect, use ``submit_feedback`` with a concise evidence-based reason.",
    "8. When work uncovers durable, verified team-specific knowledge that is missing from the Hub, first summarize it with the exact six-section Markdown format defined below, then use ``submit_knowledge_candidate``. The server validates and canonicalizes the same format. Do not submit raw notes/transcripts, secrets, credentials, customer-sensitive data, or speculative conclusions.",
    "9. Do not call repository sync, rollback, or administrative operations unless the user explicitly requests that operational action.",
    "",
    "Typical triggers include OTA, Yocto, embedded Linux, firmware, CI/CD, testing, CVE management, release engineering, platform tooling, and project-specific design/API questions.",
    "",
    "For durable knowledge, the final response must use this exact Markdown summary format:",
    "# Title",
    "",
    "## 问题",
    "## 根因",
    "## 解决方案",
    "## 验证结果",
    "## 适用范围",
    "## 约束/限制",
    $ClaudeEnd
) -join [Environment]::NewLine

$ClaudeMdContent = Get-Content -Raw $ClaudeMd
if ($null -eq $ClaudeMdContent) { $ClaudeMdContent = "" }
$ClaudeMdContent = $ClaudeMdContent.TrimStart([char]0xFEFF)
$ClaudeMdContent = Replace-ManagedBlock $ClaudeMdContent $ClaudeBegin $ClaudeEnd $ClaudeBlock
Write-Utf8NoBom -Path $ClaudeMd -Content $ClaudeMdContent

if (-not $SkipMcp) {
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Warning "claude CLI not found; Hooks installed, MCP registration skipped."
  } else {
    try { & claude mcp remove $ServerName --scope user 2>$null | Out-Null } catch {}
    $mcpJson = '{"type":"http","url":"' + $McpUrl + '","headers":{"Authorization":"Bearer ${' + $ApiKeyEnv + '}"}}'
    & claude mcp add-json $ServerName $mcpJson --scope user
    if ($LASTEXITCODE -ne 0) { throw "claude mcp add-json failed" }
  }
}

Write-Host "Configured Claude Code hooks: $SettingsFile"
Write-Host "Hook endpoint: $EventUrl"
Write-Host "Configured global CLAUDE.md block: $ClaudeMd"
Write-Host "Install state: $HookConf"
Write-Host "Auto Knowledge capture: $AutoKnowledgeValue"
if (-not $SkipMcp) { Write-Host "MCP URL: $McpUrl" }
Write-Host "API key environment variable: $ApiKeyEnv"
Write-Host "Set that environment variable before starting Claude Code."
Write-Host "Verify with: claude mcp get $ServerName"
