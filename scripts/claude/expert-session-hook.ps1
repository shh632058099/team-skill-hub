# Claude Code PreToolUse: preserve the native conversation session identity.
try {
    $raw = [Console]::In.ReadToEnd()
    $event = $raw | ConvertFrom-Json
    if ($event.hook_event_name -ne 'PreToolUse') { exit 0 }
    if ([string]$event.tool_name -notmatch '^mcp__teamSkillHub__(submit_expert_task_auto|submit_expert_task)$') { exit 0 }
    $session = [guid]::Empty
    if (-not [guid]::TryParse([string]$event.session_id, [ref]$session)) { exit 0 }
    if ([string]$event.session_id -cne $session.ToString('D')) { exit 0 }
    if ($null -eq $event.tool_input -or $event.tool_input -isnot [pscustomobject]) { exit 0 }
    $inputData = @{}
    foreach ($property in $event.tool_input.PSObject.Properties) { $inputData[$property.Name] = $property.Value }
    $inputData['clientSessionId'] = $session.ToString('D')
    $inputData.Remove('clientSessionProof')
    $configPath = if ($env:TEAM_SKILL_HUB_HOOK_CONFIG) { $env:TEAM_SKILL_HUB_HOOK_CONFIG } else { Join-Path $PSScriptRoot 'team-skill-hub.conf' }
    $keyEnv = 'TEAM_SKILL_HUB_API_KEY'
    if (Test-Path -LiteralPath $configPath) {
        foreach ($line in [System.IO.File]::ReadAllLines($configPath)) {
            if ($line -match '^api_key_env=([A-Za-z_][A-Za-z0-9_]*)$') { $keyEnv = $Matches[1] }
        }
    }
    $credential = [Environment]::GetEnvironmentVariable($keyEnv)
    if ($credential -and $inputData['idempotencyKey'] -is [string]) {
        $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
        $message = "team-skill-hub/client-session/v1`n$($session.ToString('D'))`n$($inputData['idempotencyKey'])`n$timestamp"
        $mac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($credential))
        try { $signature = [BitConverter]::ToString($mac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($message))).Replace('-', '').ToLowerInvariant() }
        finally { $mac.Dispose() }
        $inputData['clientSessionProof'] = "$timestamp.$signature"
    }
    $result = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; updatedInput = $inputData } }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 30 -Compress))
} catch {
    # An invalid hook event must not block unrelated Claude operations.
    exit 0
}
