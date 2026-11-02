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
    if ($event.hook_event_name -eq 'UserPromptSubmit') {
        if (Test-Path -LiteralPath $statePath) { Remove-Item -Force -LiteralPath $statePath }
        $turnId = [string]$event.prompt_id
        if ([string]::IsNullOrWhiteSpace($turnId) -or $turnId.Length -gt 200) { exit 0 }
        $material = "team-skill-hub/source-request/v1`nclaude_code`n$sessionId`n$turnId"
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $digest = [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($material))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
        $temp = $statePath + '.tmp'
        [System.IO.File]::WriteAllText($temp, (@{ session_id=$sessionId; turn_id=$turnId; source_request_id=('srq_' + $digest) } | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -Force $temp $statePath
        exit 0
    }
    if ($event.hook_event_name -ne 'PreToolUse') { exit 0 }
    if ([string]$event.tool_name -notmatch '^mcp__teamSkillHub__(submit_expert_task_auto|submit_expert_task)$') { exit 0 }
    if ($null -eq $event.tool_input -or $event.tool_input -isnot [pscustomobject]) { exit 0 }
    $inputData = @{}
    foreach ($property in $event.tool_input.PSObject.Properties) { $inputData[$property.Name] = $property.Value }
    $inputData['clientSessionId'] = $sessionId
    $inputData.Remove('clientSessionProof')
    $inputData.Remove('sourceRequestId')
    $requestId = $null
    $turnId = if ($event.prompt_id) { [string]$event.prompt_id } else { [string]$event.turn_id }
    if (-not [string]::IsNullOrWhiteSpace($turnId) -and $turnId.Length -le 200) {
        $material = "team-skill-hub/source-request/v1`nclaude_code`n$sessionId`n$turnId"
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $digest = [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($material))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        $requestId = 'srq_' + $digest
    } elseif (Test-Path -LiteralPath $statePath) {
        try { $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json; if ($state.session_id -eq $sessionId) { $requestId = [string]$state.source_request_id } } catch { }
    }
    if ($requestId -notmatch '^srq_[a-f0-9]{64}$') { $requestId = $null } else { $inputData['sourceRequestId'] = $requestId }
    $configPath = if ($env:TEAM_SKILL_HUB_HOOK_CONFIG) { $env:TEAM_SKILL_HUB_HOOK_CONFIG } else { Join-Path $PSScriptRoot 'team-skill-hub.conf' }
    $keyEnv = 'TEAM_SKILL_HUB_API_KEY'
    if (Test-Path -LiteralPath $configPath) { foreach ($line in [System.IO.File]::ReadAllLines($configPath)) { if ($line -match '^api_key_env=([A-Za-z_][A-Za-z0-9_]*)$') { $keyEnv = $Matches[1] } } }
    $credential = [Environment]::GetEnvironmentVariable($keyEnv)
    if ($credential -and $inputData['idempotencyKey'] -is [string]) {
        $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
        if ($requestId) { $message = "team-skill-hub/client-session/v2`n$sessionId`n$requestId`n$($inputData['idempotencyKey'])`n$timestamp" }
        else { $message = "team-skill-hub/client-session/v1`n$sessionId`n$($inputData['idempotencyKey'])`n$timestamp" }
        $mac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($credential))
        try { $signature = [BitConverter]::ToString($mac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($message))).Replace('-', '').ToLowerInvariant() }
        finally { $mac.Dispose() }
        $inputData['clientSessionProof'] = "$timestamp.$signature"
    }
    $result = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; updatedInput = $inputData } }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 30 -Compress))
} catch { exit 0 }
