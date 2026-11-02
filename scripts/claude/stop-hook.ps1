# Native Windows Claude Stop hook. No Bash/HOME path conversion required.
# A best-effort telemetry hook: do not prevent Claude from completing.
try {
    $configPath = if ($env:TEAM_SKILL_HUB_HOOK_CONFIG) { $env:TEAM_SKILL_HUB_HOOK_CONFIG } else { Join-Path $PSScriptRoot 'team-skill-hub.conf' }
    if (-not (Test-Path -LiteralPath $configPath)) { exit 0 }
    $settings = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($configPath)) {
        $parts = $line -split '=', 2
        if ($parts.Count -eq 2) { $settings[$parts[0]] = $parts[1] }
    }
    $url = [string]$settings['event_url']
    $name = if ($settings['api_key_env']) { [string]$settings['api_key_env'] } else { 'TEAM_SKILL_HUB_API_KEY' }
    if (-not $url -or $name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { exit 0 }
    $apiKey = [Environment]::GetEnvironmentVariable($name)
    if (-not $apiKey) { exit 0 }
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw) { exit 0 }
    $event = $raw | ConvertFrom-Json
    if ($event.hook_event_name -ne 'Stop' -or -not ([string]$event.session_id).Trim()) { exit 0 }
    $payload = @{ hook_event_name = 'Stop'; session_id = ([string]$event.session_id).Trim() }
    foreach ($field in @('prompt_id','cwd','model','permission_mode','reason','stop_hook_active')) {
        $property = $event.PSObject.Properties[$field]
        if ($null -ne $property -and $null -ne $property.Value -and
            ($property.Value -is [string] -or $property.Value -is [bool] -or $property.Value -is [ValueType])) {
            $payload[$field] = $property.Value
        }
    }
    if ($settings['capture_stop_message'] -ne 'false' -and $event.last_assistant_message -is [string]) {
        $message = ([string]$event.last_assistant_message).Trim()
        if ($message) {
            $message = $message -creplace '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[redacted-email]'
            $message = $message -creplace '(?:skh_|sk-|ghp_|glpat-)[A-Za-z0-9_-]{8,}', '[redacted-token]'
            $message = $message -replace '(?i)(password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+', '$1=[redacted]'
            $payload['last_assistant_message'] = $message.Substring(0, [Math]::Min(50000, $message.Length))
        }
    }
    $json = $payload | ConvertTo-Json -Depth 10 -Compress
    Invoke-WebRequest -UseBasicParsing -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Headers @{ Authorization = ('Bearer ' + $apiKey) } -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 4 | Out-Null
} catch {
    exit 0
}
