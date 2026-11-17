# Codex hook: bind Team Skill Hub Work tools to the native session and user turn.
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$Domain = 'team-skill-hub/source-request/v1'
$Lf = [char]10
$isSubmissionTool = $false

function Emit-Deny([string]$Reason) {
    $result = @{ hookSpecificOutput = @{ hookEventName='PreToolUse'; permissionDecision='deny'; permissionDecisionReason=$Reason } }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 20 -Compress))
}
function Get-NativeTurnToken($Event) {
    foreach ($name in @('turn_id','prompt_id')) {
        $prop = $Event.PSObject.Properties[$name]
        if ($null -ne $prop) {
            $value = [string]$prop.Value
            if (-not [string]::IsNullOrWhiteSpace($value) -and $value.Trim().Length -le 200) { return $value.Trim() }
        }
    }
    return $null
}
function Get-SourceRequestId([string]$SessionId, [string]$TurnToken) {
    $material = $Domain + $Lf + 'codex' + $Lf + $SessionId + $Lf + $TurnToken
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hex = [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($material))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return "srq_$hex"
}
function Get-StatePath([string]$SessionId) {
    $root = if ($env:TEAM_SKILL_HUB_REQUEST_STATE_DIR) { $env:TEAM_SKILL_HUB_REQUEST_STATE_DIR } else { Join-Path $HOME '.team-skill-hub/request-state/codex' }
    return Join-Path $root ($SessionId + '.json')
}
function Write-RequestState([string]$SessionId, $Event) {
    $token = Get-NativeTurnToken $Event
    if ([string]::IsNullOrWhiteSpace($token)) { $token = 'generated:' + [guid]::NewGuid().ToString('D') }
    $requestId = Get-SourceRequestId $SessionId $token
    $target = Get-StatePath $SessionId
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
    $temp = $target + '.tmp-' + $PID
    [System.IO.File]::WriteAllText($temp, (@{session_id=$SessionId;turn_token=$token;source_request_id=$requestId}|ConvertTo-Json -Compress), $utf8)
    Move-Item -LiteralPath $temp -Destination $target -Force
}
function Read-SourceRequestId([string]$SessionId, $Event) {
    $token = Get-NativeTurnToken $Event
    if (-not [string]::IsNullOrWhiteSpace($token)) { return Get-SourceRequestId $SessionId $token }
    $target = Get-StatePath $SessionId
    if (-not (Test-Path -LiteralPath $target)) { return $null }
    try {
        $state = Get-Content -Raw -LiteralPath $target | ConvertFrom-Json -ErrorAction Stop
        $requestId = [string]$state.source_request_id
        if ([string]$state.session_id -eq $SessionId -and $requestId -match '^srq_[a-f0-9]{64}$') { return $requestId }
    } catch {}
    return $null
}

try {
    $raw = [Console]::In.ReadToEnd()
    $event = $raw | ConvertFrom-Json -ErrorAction Stop
    $session = [guid]::Empty
    if (-not [guid]::TryParseExact([string]$event.session_id, 'D', [ref]$session)) { exit 0 }
    $sessionId = $session.ToString('D').ToLowerInvariant()
    if ([string]$event.hook_event_name -eq 'UserPromptSubmit') {
        try { Write-RequestState $sessionId $event } catch {}
        exit 0
    }
    if ([string]$event.hook_event_name -ne 'PreToolUse') { exit 0 }

    $codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
    $configPath = if ($env:TEAM_SKILL_HUB_HOOK_CONFIG) { $env:TEAM_SKILL_HUB_HOOK_CONFIG } else { Join-Path $codexDir 'hooks/team-skill-hub.conf' }
    $serverName = 'teamSkillHub'
    $keyEnv = 'TEAM_SKILL_HUB_API_KEY'
    if (Test-Path -LiteralPath $configPath) {
        foreach ($line in [System.IO.File]::ReadAllLines($configPath)) {
            if ($line -match '^server_name=([A-Za-z0-9_-]+)$') { $serverName = $Matches[1] }
            if ($line -match '^api_key_env=([A-Za-z_][A-Za-z0-9_]*)$') { $keyEnv = $Matches[1] }
        }
    }
    $expectedTools = @("mcp__$($serverName)__submit_work", "mcp__$($serverName)__update_work_source")
    if ([string]$event.tool_name -notin $expectedTools) { exit 0 }
    $isSubmissionTool = $true
    if ($null -eq $event.tool_input -or $event.tool_input -isnot [pscustomobject]) {
        Emit-Deny 'Team Skill Hub cannot attach the native Codex session identity; submission was blocked.'
        exit 0
    }
    $inputData = @{}
    foreach ($property in $event.tool_input.PSObject.Properties) { $inputData[$property.Name] = $property.Value }
    $inputData.Remove('sourceRequestId')
    $inputData.Remove('clientSessionProof')
    $isUpdate = [string]$event.tool_name -eq "mcp__$($serverName)__update_work_source"
    $bindingKey = if ($isUpdate) { $inputData['workItemId'] } else { $inputData['idempotencyKey'] }
    if ($bindingKey -isnot [string] -or [string]::IsNullOrWhiteSpace($bindingKey)) {
        Emit-Deny 'Team Skill Hub requires a stable binding key before session identity can be attached.'
        exit 0
    }
    $credential = [Environment]::GetEnvironmentVariable($keyEnv)
    if (-not $credential) {
        Emit-Deny "Team Skill Hub cannot sign the Codex session proof because $keyEnv is unavailable."
        exit 0
    }
    $inputData['clientSessionId'] = $sessionId
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
    if ($isUpdate) {
        $message = 'team-skill-hub/client-session/v1' + $Lf + $sessionId + $Lf + $bindingKey + $Lf + $timestamp
    } else {
        $requestId = Read-SourceRequestId $sessionId $event
        if ([string]::IsNullOrWhiteSpace($requestId)) {
            Emit-Deny 'Team Skill Hub cannot identify the current native user turn; submit_work was blocked.'
            exit 0
        }
        $inputData['sourceRequestId'] = $requestId
        $message = 'team-skill-hub/client-session/v2' + $Lf + $sessionId + $Lf + $requestId + $Lf + $bindingKey + $Lf + $timestamp
    }
    $mac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($credential))
    try { $signature = [BitConverter]::ToString($mac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($message))).Replace('-', '').ToLowerInvariant() }
    finally { $mac.Dispose() }
    $inputData['clientSessionProof'] = "$timestamp.$signature"
    $result = @{ hookSpecificOutput = @{ hookEventName='PreToolUse'; permissionDecision='allow'; updatedInput=$inputData } }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 30 -Compress))
} catch {
    if ($isSubmissionTool) { Emit-Deny 'Team Skill Hub could not safely attach the native Codex session identity; submission was blocked.' }
    exit 0
}
