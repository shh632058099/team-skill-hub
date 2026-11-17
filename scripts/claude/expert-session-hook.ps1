# Claude Code hook: bind Team Skill Hub Work tools to the native session and user turn.
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$Domain = 'team-skill-hub/source-request/v1'
$Lf = [char]10

function Fail-WorkHook([string]$Code) {
    [Console]::Error.WriteLine("TEAM_SKILL_HUB_WORK_HOOK_ERROR:$Code")
    exit 2
}
function Get-NativeTurnToken($Event) {
    foreach ($name in @('prompt_id','turn_id')) {
        $prop = $Event.PSObject.Properties[$name]
        if ($null -ne $prop) {
            $value = [string]$prop.Value
            if (-not [string]::IsNullOrWhiteSpace($value) -and $value.Trim().Length -le 200) { return $value.Trim() }
        }
    }
    return $null
}
function Get-SourceRequestId([string]$SessionId, [string]$TurnToken) {
    $material = $Domain + $Lf + 'claude_code' + $Lf + $SessionId + $Lf + $TurnToken
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hex = [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($material))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return "srq_$hex"
}
function Get-StatePath([string]$SessionId) {
    $root = if ($env:TEAM_SKILL_HUB_REQUEST_STATE_DIR) { $env:TEAM_SKILL_HUB_REQUEST_STATE_DIR } else { Join-Path $HOME '.team-skill-hub/request-state/claude' }
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

$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) { Fail-WorkHook 'EMPTY_INPUT' }
try { $event = $raw | ConvertFrom-Json -ErrorAction Stop } catch { Fail-WorkHook 'INVALID_JSON' }

if ([string]$event.hook_event_name -eq 'UserPromptSubmit') {
    $session = [guid]::Empty
    if ([guid]::TryParseExact([string]$event.session_id, 'D', [ref]$session)) {
        try { Write-RequestState ($session.ToString('D').ToLowerInvariant()) $event } catch {}
    }
    exit 0
}
if ([string]$event.hook_event_name -ne 'PreToolUse') { exit 0 }
$toolName = [string]$event.tool_name
if ($toolName -notmatch '^mcp__teamSkillHub__(submit_work|update_work_source)$') { exit 0 }

try {
    $session = [guid]::Empty
    if (-not [guid]::TryParseExact([string]$event.session_id, 'D', [ref]$session)) { Fail-WorkHook 'INVALID_SESSION_ID' }
    $sessionId = $session.ToString('D').ToLowerInvariant()
    if ([string]$event.session_id -cne $sessionId) { Fail-WorkHook 'NON_CANONICAL_SESSION_ID' }
    if ($null -eq $event.tool_input) { Fail-WorkHook 'MISSING_TOOL_INPUT' }
    $inputData = @{}
    if ($event.tool_input -is [System.Collections.IDictionary]) {
        foreach ($key in $event.tool_input.Keys) { $inputData[[string]$key] = $event.tool_input[$key] }
    } elseif ($null -ne $event.tool_input.PSObject) {
        foreach ($property in $event.tool_input.PSObject.Properties) { $inputData[$property.Name] = $property.Value }
    } else { Fail-WorkHook 'INVALID_TOOL_INPUT' }

    $isUpdate = $toolName -match '__update_work_source$'
    $bindingKey = if ($isUpdate) { $inputData['workItemId'] } else { $inputData['idempotencyKey'] }
    if ($bindingKey -isnot [string] -or [string]::IsNullOrWhiteSpace($bindingKey)) { Fail-WorkHook 'MISSING_BINDING_KEY' }

    $configPath = if ($env:TEAM_SKILL_HUB_HOOK_CONFIG) { $env:TEAM_SKILL_HUB_HOOK_CONFIG } else { Join-Path $PSScriptRoot 'team-skill-hub.conf' }
    $keyEnv = 'TEAM_SKILL_HUB_API_KEY'
    if (Test-Path -LiteralPath $configPath) {
        try {
            foreach ($line in [System.IO.File]::ReadAllLines($configPath)) {
                if ($line -match '^api_key_env=([A-Za-z_][A-Za-z0-9_]*)$') { $keyEnv = $Matches[1] }
            }
        } catch { Fail-WorkHook 'CONFIG_READ_FAILED' }
    }
    $credential = [Environment]::GetEnvironmentVariable($keyEnv)
    if ([string]::IsNullOrEmpty($credential)) { Fail-WorkHook 'CREDENTIAL_UNAVAILABLE' }

    $inputData['clientSessionId'] = $sessionId
    $inputData.Remove('clientSessionProof')
    $inputData.Remove('sourceRequestId')
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
    if ($isUpdate) {
        $message = 'team-skill-hub/client-session/v1' + $Lf + $sessionId + $Lf + $bindingKey + $Lf + $timestamp
    } else {
        $requestId = Read-SourceRequestId $sessionId $event
        if ([string]::IsNullOrWhiteSpace($requestId)) { Fail-WorkHook 'SOURCE_REQUEST_UNAVAILABLE' }
        $inputData['sourceRequestId'] = $requestId
        $message = 'team-skill-hub/client-session/v2' + $Lf + $sessionId + $Lf + $requestId + $Lf + $bindingKey + $Lf + $timestamp
    }
    $mac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($credential))
    try { $signature = [BitConverter]::ToString($mac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($message))).Replace('-', '').ToLowerInvariant() }
    finally { $mac.Dispose() }
    $inputData['clientSessionProof'] = "$timestamp.$signature"
    $result = @{ hookSpecificOutput = @{ hookEventName='PreToolUse'; updatedInput=$inputData } }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 30 -Compress))
} catch {
    Fail-WorkHook 'PROCESSING_FAILED'
}
