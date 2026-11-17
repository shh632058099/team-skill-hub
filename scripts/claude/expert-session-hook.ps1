# Claude Code hook: bind Team Skill Hub Work tools to the native Claude session.
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

function Fail-WorkHook([string]$Code) {
    [Console]::Error.WriteLine("TEAM_SKILL_HUB_WORK_HOOK_ERROR:$Code")
    exit 2
}

$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) { Fail-WorkHook 'EMPTY_INPUT' }

try {
    $event = $raw | ConvertFrom-Json -ErrorAction Stop
} catch {
    Fail-WorkHook 'INVALID_JSON'
}

if ([string]$event.hook_event_name -ne 'PreToolUse') { exit 0 }
$toolName = [string]$event.tool_name
if ($toolName -notmatch '^mcp__teamSkillHub__(submit_work|update_work_source)$') { exit 0 }

try {
    $session = [guid]::Empty
    if (-not [guid]::TryParse([string]$event.session_id, [ref]$session)) { Fail-WorkHook 'INVALID_SESSION_ID' }
    $sessionId = $session.ToString('D').ToLowerInvariant()
    if ([string]$event.session_id -cne $sessionId) { Fail-WorkHook 'NON_CANONICAL_SESSION_ID' }

    if ($null -eq $event.tool_input) { Fail-WorkHook 'MISSING_TOOL_INPUT' }
    $inputData = @{}
    if ($event.tool_input -is [System.Collections.IDictionary]) {
        foreach ($key in $event.tool_input.Keys) { $inputData[[string]$key] = $event.tool_input[$key] }
    } elseif ($null -ne $event.tool_input.PSObject) {
        foreach ($property in $event.tool_input.PSObject.Properties) { $inputData[$property.Name] = $property.Value }
    } else {
        Fail-WorkHook 'INVALID_TOOL_INPUT'
    }

    $bindingKey = if ($toolName -match '__update_work_source$') { $inputData['workItemId'] } else { $inputData['idempotencyKey'] }
    if ($bindingKey -isnot [string] -or [string]::IsNullOrWhiteSpace($bindingKey)) { Fail-WorkHook 'MISSING_BINDING_KEY' }

    $configPath = if ($env:TEAM_SKILL_HUB_HOOK_CONFIG) { $env:TEAM_SKILL_HUB_HOOK_CONFIG } else { Join-Path $PSScriptRoot 'team-skill-hub.conf' }
    $keyEnv = 'TEAM_SKILL_HUB_API_KEY'
    if (Test-Path -LiteralPath $configPath) {
        try {
            foreach ($line in [System.IO.File]::ReadAllLines($configPath)) {
                if ($line -match '^api_key_env=([A-Za-z_][A-Za-z0-9_]*)$') { $keyEnv = $Matches[1] }
            }
        } catch {
            Fail-WorkHook 'CONFIG_READ_FAILED'
        }
    }

    $credential = [Environment]::GetEnvironmentVariable($keyEnv)
    if ([string]::IsNullOrEmpty($credential)) { Fail-WorkHook 'CREDENTIAL_UNAVAILABLE' }

    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
    $message = "team-skill-hub/client-session/v1`n$sessionId`n$bindingKey`n$timestamp"
    $mac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($credential))
    try {
        $signature = [BitConverter]::ToString($mac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($message))).Replace('-', '').ToLowerInvariant()
    } finally {
        $mac.Dispose()
    }

    $inputData['clientSessionId'] = $sessionId
    $inputData.Remove('clientSessionProof')
    $inputData.Remove('sourceRequestId')
    $inputData['clientSessionProof'] = "$timestamp.$signature"
    $result = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; updatedInput = $inputData } }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 30 -Compress))
} catch {
    Fail-WorkHook 'PROCESSING_FAILED'
}
