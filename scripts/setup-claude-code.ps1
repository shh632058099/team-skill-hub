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
$HookRuntimeVersion = $null
$HookSchemaVersion = $null

$ServerNameExplicit = $PSBoundParameters.ContainsKey("ServerName")
$ApiKeyEnvExplicit = $PSBoundParameters.ContainsKey("ApiKeyEnv")

$ClaudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$SettingsFile = Join-Path $ClaudeDir 'settings.json'
$ClaudeMd = Join-Path $ClaudeDir 'CLAUDE.md'
$HooksDir = Join-Path $ClaudeDir 'hooks'
$HookConf = Join-Path $HooksDir 'team-skill-hub.conf'
$StopGate = Join-Path $HooksDir 'team-skill-hub-claude-stop.ps1'
$SessionGate = Join-Path $HooksDir 'team-skill-hub-expert-session.ps1'

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
$ApiKeyValue = [Environment]::GetEnvironmentVariable($ApiKeyEnv)
if ($null -ne $ApiKeyValue -and $ApiKeyValue -match '[\x00-\x1F\x7F]') { throw "API key environment variable $ApiKeyEnv contains control characters that are invalid in an HTTP header" }

$McpUrl = $Url.TrimEnd('/')
if (-not $McpUrl.EndsWith('/mcp')) { $McpUrl = $McpUrl.TrimEnd('/') + '/mcp' }
$BaseUrl = $McpUrl.Substring(0, $McpUrl.Length - 4)
$EventUrl = $BaseUrl + '/client-events/claude-code'
$ClientRoot = if ($env:TEAM_SKILL_HUB_CLIENT_ROOT) { $env:TEAM_SKILL_HUB_CLIENT_ROOT } else { Join-Path $HOME '.team-skill-hub' }
$LocalBootstrap = Join-Path $PSScriptRoot 'bootstrap-client-integration.ps1'
$TempBootstrap = $null
try {
    if (Test-Path $LocalBootstrap) {
        $BootstrapPath = $LocalBootstrap
    } else {
        $TempBootstrap = Join-Path ([System.IO.Path]::GetTempPath()) ("team-skill-hub-bootstrap-" + [guid]::NewGuid().ToString('N') + ".ps1")
        $BootstrapUrl = $BaseUrl + '/client-integration/bootstrap-client-integration.ps1'
        try { Invoke-WebRequest -UseBasicParsing -Uri $BootstrapUrl -OutFile $TempBootstrap } catch { throw "Failed to download Team Skill Hub bootstrap from $BootstrapUrl`: $($_.Exception.Message)" }
        $BootstrapPath = $TempBootstrap
    }
    & $BootstrapPath -Client claude -ConfigHome $ClaudeDir -HubBaseUrl $BaseUrl -ServerName $ServerName -ApiKeyEnv $ApiKeyEnv
} finally {
    if ($TempBootstrap) { Remove-Item -Force $TempBootstrap -ErrorAction SilentlyContinue }
}
$ClientLauncher = Join-Path $ClientRoot 'bin\team-skill-hub-client.ps1'
$ClientVersion = (Get-Content -Raw (Join-Path $ClientRoot 'current')).Trim()
$ClientRelease = Get-Content -Raw (Join-Path $ClientRoot ("releases\v$ClientVersion\release.json")) | ConvertFrom-Json
$ClientReleaseDir = Join-Path $ClientRoot ("releases\v$ClientVersion")
$HookRuntimeVersion = [string]$ClientRelease.hookRuntimeVersion
$HookSchemaVersion = [string]$ClientRelease.hookSchemaVersion

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
    return ,@($Value | ForEach-Object { Convert-ToHashtable $_ })
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
if (-not $SkipMcp) {
  if (-not $root.ContainsKey('permissions') -or -not ($root['permissions'] -is [System.Collections.IDictionary])) {
    $root['permissions'] = @{}
  }
  if ($root['permissions'].ContainsKey('additionalDirectories') -and $root['permissions']['additionalDirectories'] -is [string]) {
    $root['permissions']['additionalDirectories'] = @($root['permissions']['additionalDirectories'])
  }
  $permissionRule = 'mcp__' + $ServerName + '__*'
  $allow = @($root['permissions']['allow']) | Where-Object { $_ -is [string] -and -not [string]::IsNullOrWhiteSpace($_) }
  if ($allow -notcontains $permissionRule) { $allow += $permissionRule }
  $root['permissions']['allow'] = @($allow)
}

$httpHandler = @{
  type = 'http'
  url = $EventUrl
  timeout = 2
  headers = @{ Authorization = ('Bearer ${' + $ApiKeyEnv + '}') }
  allowedEnvVars = @($ApiKeyEnv)
}
$stopHandler = @{
  type = 'command'
  command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $StopGate + '"'
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
$sessionKept = @()
foreach ($groupValue in @($root['hooks']['SessionStart'])) {
  if ($null -eq $groupValue) { continue }
  $group = Convert-ToHashtable $groupValue
  $handlers = @($group['hooks']) | Where-Object { -not ([string]$_['command'] -like '*team-skill-hub-client*') }
  if ($handlers.Count -gt 0) { $copy=@{}; foreach($key in $group.Keys){$copy[$key]=$group[$key]}; $copy['hooks']=@($handlers); $sessionKept += ,$copy }
}
$sessionCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $ClientLauncher + '" session-start --client claude'
$displayCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $ClientLauncher + '" session-start-display --client claude'
$sessionKept += ,@{ hooks = @(@{ type='command'; command=$sessionCommand; timeout=2 }) }
$sessionKept += ,@{ hooks = @(@{ type='command'; command=$displayCommand; timeout=2 }) }
$root['hooks']['SessionStart'] = @($sessionKept)

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

if ($ServerName -eq 'teamSkillHub') {
  $kept = @()
  foreach ($groupValue in @($root['hooks']['PreToolUse'])) {
    if ($null -eq $groupValue) { continue }
    $group = Convert-ToHashtable $groupValue
    $handlers = @($group['hooks']) | Where-Object {
      -not ([string]$_['command'] -like '*expert-session-hook*' -or [string]$_['command'] -like '*team-skill-hub-expert-session*')
    }
    if ($handlers.Count -gt 0) {
      $copy = @{}; foreach ($key in $group.Keys) { $copy[$key] = $group[$key] }
      $copy['hooks'] = @($handlers)
      $kept += ,$copy
    }
  }
  $sessionCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $SessionGate + '"'
  $kept += ,@{ matcher='^mcp__teamSkillHub__(submit_work|update_work_source)$'; hooks=@(@{type='command';command=$sessionCommand;timeout=5}) }
  $root['hooks']['PreToolUse'] = @($kept)
  $promptKept = @()
  foreach ($groupValue in @($root['hooks']['UserPromptSubmit'])) {
    if ($null -eq $groupValue) { continue }
    $group = Convert-ToHashtable $groupValue
    $handlers = @($group['hooks']) | Where-Object { -not ([string]$_['command'] -like '*team-skill-hub-expert-session*') }
    if ($handlers.Count -gt 0) { $copy=@{}; foreach($key in $group.Keys){$copy[$key]=$group[$key]}; $copy['hooks']=@($handlers); $promptKept += ,$copy }
  }
  $promptKept += ,@{ hooks=@(@{type='command';command=$sessionCommand;timeout=2}) }
  $root['hooks']['UserPromptSubmit'] = @($promptKept)
}

$json = $root | ConvertTo-Json -Depth 20
Write-Utf8NoBom -Path $SettingsFile -Content $json

Copy-Item -Force (Join-Path $ClientReleaseDir 'scripts\claude\stop-hook.ps1') $StopGate
if ($ServerName -eq 'teamSkillHub') {
    Copy-Item -Force (Join-Path $ClientReleaseDir 'scripts\claude\expert-session-hook.ps1') $SessionGate
}

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
    "2. Treat ``discover`` as the default routing entry point. Let Skills, Knowledge, Prompts, Agents, and Tools compete by relevance instead of pre-classifying every request on the client. Normal discovery/search automatically covers all repositories visible to the current API Token / Principal; do not pre-list, infer, guess, or pass repository IDs.",
    "3. If the user explicitly asks to limit retrieval to a particular Team Skill Hub repository, use ``discover_scoped``. Call ``list_skill_repositories`` only when the user explicitly asks about repositories or when you need to resolve the repository ID for that explicit scoped request. Never derive scoped search from cwd, Git remote, project name, or task context.",
    "4. If ``discover`` returns a clearly relevant Skill, call ``get_skill`` before executing the task. If it returns clearly relevant Knowledge, call ``get_knowledge`` before answering or changing code. Load Prompts, Agents, or Tools only when they are actually relevant.",
    "5. Use ``resolve_skill``, ``search_skills``, ``search_knowledge``, or other asset-specific search tools only when ``discover`` is ambiguous, insufficient, or a more precise follow-up search is needed. Do not run Skill and Knowledge searches in parallel by default.",
    "6. Load only the selected assets; do not load every candidate. If no relevant Team Skill Hub asset is found, continue normally and do not invent team-specific guidance.",
    "7. Respect repository visibility, role filtering, and client compatibility.",
    "8. If a retrieved Team Skill Hub asset is clearly outdated or incorrect, use ``submit_feedback`` with a concise evidence-based reason.",
    "9. When work uncovers durable, verified team-specific knowledge that is missing from the Hub, call ``get_knowledge_submission_spec`` immediately before submission, follow the returned current rules/template, then call ``submit_knowledge_candidate`` with the returned ``spec_version``. Do not submit raw notes/transcripts, secrets, credentials, customer-sensitive data, or speculative conclusions.",
    "10. When creating or submitting any Skill, including a Skill that contains only one ``SKILL.md``, use ``submit_skill_bundle``. Use ``import_type=skill`` for one Skill root and ``import_type=collection`` only for an explicit multi-Skill namespace snapshot. Never substitute ``submit_knowledge_candidate`` for a Skill. If ``submit_skill_bundle`` is not currently loaded in Claude Code, use ToolSearch to load that MCP tool before submitting.",
    "11. For delegated Expert Platform execution, submit all new work with ``submit_work``. Omit ``workflowId`` only for read-only investigation/search/statistics/code-inspection work; the Hub defaults omission to ``investigation``. For any repository modification, explicitly set a code-change workflow such as ``bug-fix``, ``feature-change``, ``refactor``, ``test-improvement``, ``build-fix``, or ``release-change``. After ``submit_work`` succeeds, must not return to the user yet; execute the returned ``followUp`` exactly. If ``followUp.tool=wait_work``, call ``wait_work`` with ``followUp.arguments`` and continue using each returned ``followUp``; active submissions start activity tracking with ``afterActivityEventId=0``. If ``followUp.tool=get_work`` because the Work is terminal or ``humanActionRequired=true``, call ``get_work`` once before replying. ``wait_work`` defaults to a 30-second long poll and advances with ``nextEventId`` + ``nextActivityEventId`` when activity tracking is enabled. ``submit_expert_task`` and ``submit_expert_task_auto`` are deprecated compatibility tools for older integrations and must not be used for new requests.",
    "12. Do not call repository sync, rollback, or administrative operations unless the user explicitly requests that operational action.",
    "13. When SessionStart reports a Team Skill Hub client integration update, never upgrade silently. Only when the user explicitly asks to upgrade Team Skill Hub, run ``powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$ClientLauncher`" upgrade``; after a required update, restart Claude Code before relying on new integration behavior.",
    "",
    "Typical triggers include OTA, Yocto, embedded Linux, firmware, CI/CD, testing, CVE management, release engineering, platform tooling, and project-specific design/API questions.",
    "",
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
    $AuthorizationHeader = 'Authorization: Bearer ${' + $ApiKeyEnv + '}'
    & claude mcp add --transport http $ServerName $McpUrl --header $AuthorizationHeader --scope user
    if ($LASTEXITCODE -ne 0) { throw "claude mcp add failed" }
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
