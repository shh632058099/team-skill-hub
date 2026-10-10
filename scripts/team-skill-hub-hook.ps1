param()
$ErrorActionPreference = "SilentlyContinue"

$CodexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$Config = $env:TEAM_SKILL_HUB_HOOK_CONFIG
if (-not $Config -and $env:PLUGIN_ROOT) {
    $PluginConfig = Join-Path $env:PLUGIN_ROOT "hooks\team-skill-hub.conf"
    if (Test-Path $PluginConfig) { $Config = $PluginConfig }
}
if (-not $Config) { $Config = Join-Path $CodexDir "hooks\team-skill-hub.conf" }
if (-not (Test-Path $Config)) { exit 0 }

$Values = @{}
Get-Content $Config | ForEach-Object {
    $parts = $_ -split "=", 2
    if ($parts.Count -eq 2) { $Values[$parts[0]] = $parts[1] }
}
$EventUrl = $Values["event_url"]
$ApiKeyEnv = if ($Values["api_key_env"]) { $Values["api_key_env"] } else { "TEAM_SKILL_HUB_API_KEY" }
$CaptureStopMessage = ([string]$Values["capture_stop_message"]).ToLowerInvariant() -eq "true"
$HookRuntimeVersion = if ($Values["runtime_version"]) { [string]$Values["runtime_version"] } else { "unknown" }
$HookSchemaVersion = if ($Values["hook_schema_version"]) { [int]$Values["hook_schema_version"] } else { 0 }
if (-not $EventUrl) { exit 0 }
$ApiKey = [Environment]::GetEnvironmentVariable($ApiKeyEnv)
if (-not $ApiKey) { exit 0 }

try {
    $raw = [Console]::In.ReadToEnd()
    $x = $raw | ConvertFrom-Json
    if (-not $x.hook_event_name -or -not $x.session_id) { exit 0 }

    $meta = @{ runtime_version = $HookRuntimeVersion; hook_schema_version = $HookSchemaVersion }
    if ([string]$x.hook_event_name -eq "SessionStart" -and $x.cwd -and (Get-Command git -ErrorAction SilentlyContinue)) {
        $cwdValue = [string]$x.cwd
        $remote = (& git -C $cwdValue config --get remote.origin.url 2>$null | Select-Object -First 1)
        if ($remote) {
            $safeRemote = ([string]$remote).Trim() -replace '^([a-z][a-z0-9+.-]*://)[^/@]+@', '$1'
            if ($safeRemote.Length -gt 1000) { $safeRemote = $safeRemote.Substring(0, 1000) }
            $meta["git_remote"] = $safeRemote
        }
        $gitRoot = (& git -C $cwdValue rev-parse --show-toplevel 2>$null | Select-Object -First 1)
        if ($gitRoot) {
            $rootValue = ([string]$gitRoot).Trim()
            if ($rootValue.Length -gt 1000) { $rootValue = $rootValue.Substring(0, 1000) }
            $meta["git_root"] = $rootValue
        }
        $gitBranch = (& git -C $cwdValue branch --show-current 2>$null | Select-Object -First 1)
        if (-not $gitBranch) {
            $gitBranch = (& git -C $cwdValue rev-parse --abbrev-ref HEAD 2>$null | Select-Object -First 1)
        }
        if ($gitBranch -and ([string]$gitBranch).Trim() -ne "HEAD") {
            $branchValue = ([string]$gitBranch).Trim()
            if ($branchValue.Length -gt 300) { $branchValue = $branchValue.Substring(0, 300) }
            $meta["git_branch"] = $branchValue
        }
    }
    function Redact-LocalText {
        param([string]$Text)
        $value = $Text -replace '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[redacted-email]'
        $value = $value -replace '(?:skh_|sk-|ghp_|glpat-)[A-Za-z0-9_-]{8,}', '[redacted-token]'
        $value = $value -replace '(?i)(password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+', '$1=[redacted]'
        if ($value.Length -gt 4000) { return $value.Substring(0, 4000) }
        return $value
    }
    $evidence = @{}
    function Add-Evidence {
        param($Value, [int]$Depth = 0)
        if ($Depth -gt 4 -or $null -eq $Value) { return }
        if ($Value -is [string] -or $Value -is [ValueType]) { return }
        $props = @($Value.PSObject.Properties) | Select-Object -First 50
        foreach ($prop in $props) {
            $name = switch ($prop.Name) {
                "exit_code" { "exit_code" }
                "exitCode" { "exit_code" }
                "returncode" { "exit_code" }
                "success" { "success" }
                "ok" { "success" }
                "tests_run_count" { "tests_run" }
                "testsRunCount" { "tests_run" }
                "tests_passed" { "tests_passed" }
                "testsPassed" { "tests_passed" }
                "tests_failed" { "tests_failed" }
                "testsFailed" { "tests_failed" }
                "duration_ms" { "duration_ms" }
                "durationMs" { "duration_ms" }
                "status" { "status" }
                "execution_state" { "status" }
                default { $null }
            }
            if ($name -and -not $evidence.ContainsKey($name)) {
                if ($prop.Value -is [bool] -or $prop.Value -is [int] -or $prop.Value -is [long] -or $prop.Value -is [double]) {
                    $evidence[$name] = $prop.Value
                } elseif ($name -eq "status" -and $prop.Value -is [string] -and $prop.Value.Length -le 40) {
                    $evidence[$name] = $prop.Value
                }
            }
            if ($null -ne $prop.Value -and -not ($prop.Value -is [string]) -and -not ($prop.Value -is [ValueType])) {
                Add-Evidence -Value $prop.Value -Depth ($Depth + 1)
            }
        }
    }
    foreach ($key in @("tool_name","tool_use_id","source","reason","trigger","start_source","end_reason","compact_trigger","stop_hook_active")) {
        $prop = $x.PSObject.Properties[$key]
        if ($null -ne $prop -and $null -ne $prop.Value) { $meta[$key] = $prop.Value }
    }
    if ([string]$x.hook_event_name -eq "PostToolUse") {
        Add-Evidence -Value $x.tool_response
        $responseText = ""
        if ($x.tool_response -is [string]) {
            $responseText = [string]$x.tool_response
        } elseif ($null -ne $x.tool_response) {
            try { $responseText = $x.tool_response | ConvertTo-Json -Depth 6 -Compress } catch { $responseText = "" }
        }
        if ([string]$x.tool_name -eq "Bash" -and $responseText) {
            $unittest = [regex]::Match($responseText, '(?i)\bRan\s+(\d+)\s+tests?\b')
            if ($unittest.Success -and [regex]::IsMatch($responseText, '(?m)^\s*OK\s*$')) {
                $count = [int]$unittest.Groups[1].Value
                if (-not $evidence.ContainsKey("tests_run")) { $evidence["tests_run"] = $count }
                if (-not $evidence.ContainsKey("tests_passed")) { $evidence["tests_passed"] = $count }
                if (-not $evidence.ContainsKey("tests_failed")) { $evidence["tests_failed"] = 0 }
                if (-not $evidence.ContainsKey("success")) { $evidence["success"] = $true }
                if (-not $evidence.ContainsKey("status")) { $evidence["status"] = "passed" }
            }
            $passed = [regex]::Match($responseText, '(?i)\b(\d+)\s+passed\b')
            $failed = [regex]::Match($responseText, '(?i)\b(\d+)\s+failed\b')
            if ($passed.Success) {
                $passedCount = [int]$passed.Groups[1].Value
                $failedCount = if ($failed.Success) { [int]$failed.Groups[1].Value } else { 0 }
                if (-not $evidence.ContainsKey("tests_passed")) { $evidence["tests_passed"] = $passedCount }
                if (-not $evidence.ContainsKey("tests_failed")) { $evidence["tests_failed"] = $failedCount }
                if (-not $evidence.ContainsKey("tests_run")) { $evidence["tests_run"] = $passedCount + $failedCount }
                if (-not $evidence.ContainsKey("success")) { $evidence["success"] = ($failedCount -eq 0) }
                if (-not $evidence.ContainsKey("status")) { $evidence["status"] = if ($failedCount -eq 0) { "passed" } else { "failed" } }
            }
        }
        if ($evidence.ContainsKey("exit_code") -and -not $evidence.ContainsKey("success")) {
            $evidence["success"] = ([int]$evidence["exit_code"] -eq 0)
        }
        if ($evidence.Count -gt 0) { $meta["evidence"] = $evidence }
    }
    if ([string]$x.hook_event_name -eq "Stop" -and $CaptureStopMessage -and $x.last_assistant_message) {
        $meta["assistant_result_excerpt"] = Redact-LocalText ([string]$x.last_assistant_message).Trim()
    }

    $body = @{ schema_version = 1; client = "codex"; event = [string]$x.hook_event_name; session_id = [string]$x.session_id; turn_id = $x.turn_id; cwd = $x.cwd; model = $x.model; permission_mode = $x.permission_mode; metadata = $meta } | ConvertTo-Json -Depth 5 -Compress
    Invoke-RestMethod -Method Post -Uri $EventUrl -Headers @{ Authorization = "Bearer $ApiKey" } -ContentType "application/json" -Body $body -TimeoutSec 2 | Out-Null
} catch {
    # Hooks must never interrupt normal Codex work.
}
exit 0
