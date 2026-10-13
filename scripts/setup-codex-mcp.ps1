param(
    [string]$Url,
    [string]$ServerName = "teamSkillHub",
    [string]$ApiKeyEnv = "TEAM_SKILL_HUB_API_KEY",
    [string]$CodexHome,
    [switch]$AutoKnowledge,
    [switch]$NoAutoKnowledge,
    [switch]$Upgrade
)

$ErrorActionPreference = "Stop"
$McpBegin = "# BEGIN TEAM-SKILL-HUB MCP"
$McpEnd = "# END TEAM-SKILL-HUB MCP"
$AgentsBegin = "<!-- BEGIN TEAM-SKILL-HUB -->"
$AgentsEnd = "<!-- END TEAM-SKILL-HUB -->"
$HookRuntimeVersion = "1.1.0"
$HookSchemaVersion = "1"

$CodexDir = if ($CodexHome) { $CodexHome } elseif ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$CodexConfig = Join-Path $CodexDir "config.toml"
$AgentsFile = Join-Path $CodexDir "AGENTS.md"
$HooksDir = Join-Path $CodexDir "hooks"
$HooksJson = Join-Path $CodexDir "hooks.json"
$HookConf = Join-Path $HooksDir "team-skill-hub.conf"
$ShHook = Join-Path $HooksDir "team-skill-hub-hook.sh"
$PsHook = Join-Path $HooksDir "team-skill-hub-hook.ps1"
if ($Upgrade.IsPresent -and (Test-Path $HookConf)) {
    $Existing = @{}
    Get-Content $HookConf | ForEach-Object {
        $parts = $_ -split "=", 2
        if ($parts.Count -eq 2) { $Existing[$parts[0]] = $parts[1] }
    }
    if ([string]::IsNullOrWhiteSpace($Url) -and $Existing["event_url"]) {
        $Url = ([string]$Existing["event_url"] -replace '/client-events/?$', '') + "/mcp"
    }
    if (-not $PSBoundParameters.ContainsKey("ServerName") -and $Existing["server_name"]) {
        $ServerName = [string]$Existing["server_name"]
    }
    if (-not $PSBoundParameters.ContainsKey("ApiKeyEnv") -and $Existing["api_key_env"]) {
        $ApiKeyEnv = [string]$Existing["api_key_env"]
    }
}

if ([string]::IsNullOrWhiteSpace($Url)) { $Url = Read-Host "Team Skill Hub MCP URL" }
if ($Url -notmatch '^https?://') { throw "MCP URL must start with http:// or https://" }
if ($ServerName -notmatch '^[A-Za-z0-9_-]+$') { throw "Invalid server name" }
if ($ApiKeyEnv -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Invalid API key env name" }
$EventUrl = ($Url -replace '/mcp/?$', '') + "/client-events"

New-Item -ItemType Directory -Force -Path $CodexDir | Out-Null
New-Item -ItemType Directory -Force -Path $HooksDir | Out-Null
if (-not (Test-Path $CodexConfig)) { New-Item -ItemType File -Path $CodexConfig | Out-Null }
if (-not (Test-Path $AgentsFile)) { New-Item -ItemType File -Path $AgentsFile | Out-Null }

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

function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

$ConfigContent = Get-Content -Raw $CodexConfig
if ($null -eq $ConfigContent) { $ConfigContent = "" }
$ConfigContent = $ConfigContent.TrimStart([char]0xFEFF)
if (-not $ConfigContent.Contains($McpBegin)) {
    $lines = $ConfigContent -split "\r?\n"
    $out = [System.Collections.Generic.List[string]]::new()
    $skip = $false
    foreach ($line in $lines) {
        if (-not $skip -and $line.Trim() -eq "[mcp_servers.$ServerName]") { $skip = $true; continue }
        if ($skip -and $line -match '^\s*\[[^\]]+\]\s*$') { $skip = $false }
        if (-not $skip) { $out.Add($line) }
    }
    $ConfigContent = ($out -join [Environment]::NewLine).TrimEnd()
}

$McpBlock = @(
    $McpBegin,
    "[mcp_servers.$ServerName]",
    "url = `"$Url`"",
    "bearer_token_env_var = `"$ApiKeyEnv`"",
    "default_tools_approval_mode = `"approve`"",
    $McpEnd
) -join [Environment]::NewLine
$ConfigContent = Replace-ManagedBlock $ConfigContent $McpBegin $McpEnd $McpBlock
Write-Utf8NoBom -Path $CodexConfig -Content $ConfigContent

$AgentsBlock = @(
    $AgentsBegin,
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
    $AgentsEnd
) -join [Environment]::NewLine
$AgentsContent = Get-Content -Raw $AgentsFile
if ($null -eq $AgentsContent) { $AgentsContent = "" }
$AgentsContent = $AgentsContent.TrimStart([char]0xFEFF)
$AgentsContent = Replace-ManagedBlock $AgentsContent $AgentsBegin $AgentsEnd $AgentsBlock
Write-Utf8NoBom -Path $AgentsFile -Content $AgentsContent

Copy-Item -Force (Join-Path $PSScriptRoot "team-skill-hub-hook.sh") $ShHook
Copy-Item -Force (Join-Path $PSScriptRoot "team-skill-hub-hook.ps1") $PsHook
$AutoKnowledgeValue = if ($NoAutoKnowledge.IsPresent) { "false" } elseif ($AutoKnowledge.IsPresent) { "true" } elseif ($Upgrade.IsPresent -and $Existing -and $Existing["capture_stop_message"]) { [string]$Existing["capture_stop_message"] } else { "true" }
Write-Utf8NoBom -Path $HookConf -Content ("event_url=" + $EventUrl + [Environment]::NewLine + "server_name=" + $ServerName + [Environment]::NewLine + "api_key_env=" + $ApiKeyEnv + [Environment]::NewLine + "capture_stop_message=" + $AutoKnowledgeValue + [Environment]::NewLine + "runtime_version=" + $HookRuntimeVersion + [Environment]::NewLine + "hook_schema_version=" + $HookSchemaVersion + [Environment]::NewLine)

if (Test-Path $HooksJson) {
    try { $HooksRoot = Get-Content -Raw $HooksJson | ConvertFrom-Json }
    catch { throw "Existing hooks.json is invalid JSON; leaving it unchanged." }
} else {
    $HooksRoot = [pscustomobject]@{}
}
if (-not $HooksRoot.PSObject.Properties["hooks"]) {
    Add-Member -InputObject $HooksRoot -MemberType NoteProperty -Name hooks -Value ([pscustomobject]@{})
}
if (-not $HooksRoot.PSObject.Properties["description"]) {
    Add-Member -InputObject $HooksRoot -MemberType NoteProperty -Name description -Value "Codex lifecycle hooks including Team Skill Hub client events."
}

$Events = @("SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","PreCompact","PostCompact","Stop","SessionEnd")
$ShCommand = 'bash "' + ($ShHook -replace '\\','/') + '"'
$PsCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $PsHook + '"'
foreach ($Event in $Events) {
    $Kept = @()
    $Prop = $HooksRoot.hooks.PSObject.Properties[$Event]
    if ($null -ne $Prop) {
        foreach ($Group in @($Prop.Value)) {
            $Handlers = @($Group.hooks | Where-Object {
                ([string]$_.command) -notmatch 'team-skill-hub-hook' -and
                ([string]$_.commandWindows) -notmatch 'team-skill-hub-hook'
            })
            if ($Handlers.Count -gt 0) {
                $Group.hooks = $Handlers
                $Kept += $Group
            }
        }
    }
    $TeamHandler = [pscustomobject]@{
        type = "command"
        command = $ShCommand
        commandWindows = $PsCommand
        async = ($Event -notin @("SessionStart","PostToolUse","Stop","SessionEnd"))
        timeout = 2
    }
    $TeamGroup = [ordered]@{ hooks = @($TeamHandler) }
    if ($Event -in @("PreToolUse","PreCompact","PostCompact")) { $TeamGroup.matcher = "^__team_skill_hub_reserved__$" }
    $Kept += [pscustomobject]$TeamGroup
    if ($null -ne $Prop) { $HooksRoot.hooks.$Event = @($Kept) }
    else { Add-Member -InputObject $HooksRoot.hooks -MemberType NoteProperty -Name $Event -Value @($Kept) }
}
$HooksContent = $HooksRoot | ConvertTo-Json -Depth 20
Write-Utf8NoBom -Path $HooksJson -Content ($HooksContent + [Environment]::NewLine)

Write-Host "Configured MCP: $CodexConfig"
Write-Host "Configured global AGENTS.md: $AgentsFile"
Write-Host "Configured Codex hooks: $HooksJson"
Write-Host "Auto Knowledge capture: $AutoKnowledgeValue"
Write-Host ""
Write-Host "Set the API key before restarting Codex:"
Write-Host ('  $env:' + $ApiKeyEnv + '="<your-api-key>"')
Write-Host ""
Write-Host "Then verify: codex mcp list"
