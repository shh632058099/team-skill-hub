param(
    [string]$Url,
    [string]$ServerName = "teamSkillHub",
    [string]$ApiKeyEnv = "TEAM_SKILL_HUB_API_KEY",
    [string]$CodexHome
)

$ErrorActionPreference = "Stop"
$McpBegin = "# BEGIN TEAM-SKILL-HUB MCP"
$McpEnd = "# END TEAM-SKILL-HUB MCP"
$AgentsBegin = "<!-- BEGIN TEAM-SKILL-HUB -->"
$AgentsEnd = "<!-- END TEAM-SKILL-HUB -->"

if ([string]::IsNullOrWhiteSpace($Url)) { $Url = Read-Host "Team Skill Hub MCP URL" }
if ($Url -notmatch '^https?://') { throw "MCP URL must start with http:// or https://" }
if ($ServerName -notmatch '^[A-Za-z0-9_-]+$') { throw "Invalid server name" }
if ($ApiKeyEnv -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Invalid API key env name" }

$CodexDir = if ($CodexHome) { $CodexHome } elseif ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$CodexConfig = Join-Path $CodexDir "config.toml"
$AgentsFile = Join-Path $CodexDir "AGENTS.md"

New-Item -ItemType Directory -Force -Path $CodexDir | Out-Null
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
    "For non-trivial engineering tasks:",
    "1. Search Team Skill Hub before implementing or reviewing from scratch when reusable internal guidance may exist.",
    "2. Use ``search_skills`` when the correct internal Skill is unknown.",
    "3. After selecting a Skill, call ``get_skill`` and follow its instructions.",
    "4. Use ``search_knowledge`` for current project design documents, APIs, troubleshooting notes, postmortems, FAQ, test documentation, and other repository facts.",
    "5. After selecting a Knowledge result, use ``get_knowledge`` when exact document or chunk context is needed.",
    "6. Prefer relevant team Skill/Knowledge over generic assumptions.",
    "7. Respect repository visibility and role filtering.",
    "8. If a retrieved Team Skill Hub asset is clearly outdated or incorrect, use ``submit_feedback`` with a concise evidence-based reason.",
    "9. When work uncovers durable, verified team-specific knowledge that is missing from the Hub, use ``submit_knowledge_candidate`` with concise source-grounded content. Do not submit secrets, credentials, customer-sensitive data, or speculative conclusions.",
    "10. Do not call repository sync, rollback, or administrative operations unless the user explicitly requests that operational action.",
    "",
    "Typical triggers include OTA, Yocto, embedded Linux, firmware, CI/CD, testing, CVE management, release engineering, platform tooling, and project-specific design/API questions.",
    $AgentsEnd
) -join [Environment]::NewLine
$AgentsContent = Get-Content -Raw $AgentsFile
if ($null -eq $AgentsContent) { $AgentsContent = "" }
$AgentsContent = $AgentsContent.TrimStart([char]0xFEFF)
$AgentsContent = Replace-ManagedBlock $AgentsContent $AgentsBegin $AgentsEnd $AgentsBlock
Write-Utf8NoBom -Path $AgentsFile -Content $AgentsContent

Write-Host "Configured MCP: $CodexConfig"
Write-Host "Configured global AGENTS.md: $AgentsFile"
Write-Host ""
Write-Host "Set the API key before restarting Codex:"
Write-Host ('  $env:' + $ApiKeyEnv + '="<your-api-key>"')
Write-Host ""
Write-Host "Then verify: codex mcp list"
