# Claude Code hook: persist native user-turn identity and sign Expert submissions.
try {
    $raw = [Console]::In.ReadToEnd()
    $event = $raw | ConvertFrom-Json
    $session = [guid]::Empty
    if (-not [guid]::TryParse([string]$event.session_id, [ref]$session)) { exit 0 }
    $sessionId = $session.ToString('D').ToLowerInvariant()
    if ([string]$event.session_id -cne $sessionId) { exit 0 }
    $stateRoot = if ($env:TEAM_SKILL_HUB_REQUEST_STATE_DIR) { $env:TEAM_SKILL_HUB_REQUEST_STATE_DIR } else { Join-Path $HOME '.team-skill-hub/request-state/claude' }
    $statePath = Join-Path $stateRoot ($sessionId + '.json')
    if ($event.hook_event_name -eq 'UserPromptSubmit') { exit 0 }
    if ($event.hook_event_name -ne 'PreToolUse') { exit 0 }
    if ([string]$event.tool_name -notmatch '^mcp__teamSkillHub__(submit_work|update_work_source)$') { exit 0 }
    if ($null -eq $event.tool_input -or $event.tool_input -isnot [pscustomobject]) { exit 0 }
    $inputData = @{}
    foreach ($property in $event.tool_input.PSObject.Properties) { $inputData[$property.Name] = $property.Value }
    $inputData['clientSessionId'] = $sessionId
    $inputData.Remove('clientSessionProof')
    $inputData.Remove('sourceRequestId')
    $bindingKey = if ([string]$event.tool_name -match '__update_work_source$') { $inputData['workItemId'] } else { $inputData['idempotencyKey'] }
    $configPath = if ($env:TEAM_SKILL_HUB_HOOK_CONFIG) { $env:TEAM_SKILL_HUB_HOOK_CONFIG } else { Join-Path $PSScriptRoot 'team-skill-hub.conf' }
    $keyEnv = 'TEAM_SKILL_HUB_API_KEY'
    if (Test-Path -LiteralPath $configPath) { foreach ($line in [System.IO.File]::ReadAllLines($configPath)) { if ($line -match '^api_key_env=([A-Za-z_][A-Za-z0-9_]*)$') { $keyEnv = $Matches[1] } } }
    $credential = [Environment]::GetEnvironmentVariable($keyEnv)
    if ($credential -and $bindingKey -is [string]) {
        $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
        $message = "team-skill-hub/client-session/v1`n$sessionId`n$bindingKey`n$timestamp"
        $mac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($credential))
        try { $signature = [BitConverter]::ToString($mac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($message))).Replace('-', '').ToLowerInvariant() }
        finally { $mac.Dispose() }
        $inputData['clientSessionProof'] = "$timestamp.$signature"
    }
    $result = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; updatedInput = $inputData } }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 30 -Compress))
} catch { exit 0 }
