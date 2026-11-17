# Codex PreToolUse: attach the native Codex thread/session identity to Team Skill Hub submissions.
$isSubmissionTool = $false
try {
    $raw = [Console]::In.ReadToEnd()
    $event = $raw | ConvertFrom-Json
    $session = [guid]::Empty
    if (-not [guid]::TryParseExact([string]$event.session_id, 'D', [ref]$session)) { exit 0 }
    $sessionId = $session.ToString('D').ToLowerInvariant()
    $stateRoot = if ($env:TEAM_SKILL_HUB_REQUEST_STATE_DIR) { $env:TEAM_SKILL_HUB_REQUEST_STATE_DIR } else { Join-Path $HOME '.team-skill-hub/request-state/codex' }
    $statePath = Join-Path $stateRoot ($sessionId + '.json')
    if ($event.hook_event_name -eq 'UserPromptSubmit') { exit 0 }
    if ($event.hook_event_name -ne 'PreToolUse') { exit 0 }
    $isSubmissionTool = [string]$event.tool_name -match '__(submit_work|update_work_source)$'

    $codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
    $configPath = if ($env:TEAM_SKILL_HUB_HOOK_CONFIG) { $env:TEAM_SKILL_HUB_HOOK_CONFIG } else { Join-Path $codexDir 'hooks\team-skill-hub.conf' }
    $serverName = 'teamSkillHub'
    $keyEnv = 'TEAM_SKILL_HUB_API_KEY'
    if (Test-Path -LiteralPath $configPath) {
        foreach ($line in [System.IO.File]::ReadAllLines($configPath)) {
            if ($line -match '^server_name=([A-Za-z0-9_-]+)$') { $serverName = $Matches[1] }
            if ($line -match '^api_key_env=([A-Za-z_][A-Za-z0-9_]*)$') { $keyEnv = $Matches[1] }
        }
    }
    $expectedTools = @("mcp__${serverName}__submit_work", "mcp__${serverName}__update_work_source")
    if ([string]$event.tool_name -notin $expectedTools) { exit 0 }

    $session = [guid]::Empty
    if (-not [guid]::TryParseExact([string]$event.session_id, 'D', [ref]$session)) {
        $result = @{ hookSpecificOutput = @{ hookEventName='PreToolUse'; permissionDecision='deny'; permissionDecisionReason='Team Skill Hub cannot verify the native Codex session ID; submission was blocked.' } }
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 20 -Compress))
        exit 0
    }
    if ($null -eq $event.tool_input -or $event.tool_input -isnot [pscustomobject]) {
        $result = @{ hookSpecificOutput = @{ hookEventName='PreToolUse'; permissionDecision='deny'; permissionDecisionReason='Team Skill Hub cannot attach the native Codex session identity; submission was blocked.' } }
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 20 -Compress))
        exit 0
    }
    $inputData = @{}
    foreach ($property in $event.tool_input.PSObject.Properties) { $inputData[$property.Name] = $property.Value }
    $inputData.Remove('sourceRequestId')
    $inputData.Remove('clientSessionProof')
    $isUpdateWorkSource = [string]$event.tool_name -eq "mcp__${serverName}__update_work_source"
    $bindingKey = if ($isUpdateWorkSource) { $inputData['workItemId'] } else { $inputData['idempotencyKey'] }
    if ($bindingKey -isnot [string] -or [string]::IsNullOrWhiteSpace($bindingKey)) {
        $result = @{ hookSpecificOutput = @{ hookEventName='PreToolUse'; permissionDecision='deny'; permissionDecisionReason='Team Skill Hub requires a stable binding key before session identity can be attached.' } }
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 20 -Compress))
        exit 0
    }
    $credential = [Environment]::GetEnvironmentVariable($keyEnv)
    if (-not $credential) {
        $result = @{ hookSpecificOutput = @{ hookEventName='PreToolUse'; permissionDecision='deny'; permissionDecisionReason="Team Skill Hub cannot sign the Codex session proof because $keyEnv is unavailable." } }
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 20 -Compress))
        exit 0
    }

    $sessionId = $session.ToString('D').ToLowerInvariant()
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
    $message = "team-skill-hub/client-session/v1`n$sessionId`n$bindingKey`n$timestamp"
    $mac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($credential))
    try { $signature = [BitConverter]::ToString($mac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($message))).Replace('-', '').ToLowerInvariant() }
    finally { $mac.Dispose() }
    $inputData['clientSessionId'] = $sessionId
    $inputData['clientSessionProof'] = "$timestamp.$signature"
    $result = @{ hookSpecificOutput = @{ hookEventName='PreToolUse'; permissionDecision='allow'; updatedInput=$inputData } }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 30 -Compress))
} catch {
    if ($isSubmissionTool) {
        $result = @{ hookSpecificOutput = @{ hookEventName='PreToolUse'; permissionDecision='deny'; permissionDecisionReason='Team Skill Hub could not safely attach the native Codex session identity; submission was blocked.' } }
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 20 -Compress))
    }
    exit 0
}
