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
    $result = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; updatedInput = $inputData } }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 30 -Compress))
} catch {
    # An invalid hook event must not block unrelated Claude operations.
    exit 0
}
