#!/usr/bin/env python3
"""Inject Claude Code's actual session_id into Team Skill Hub task submissions.

Claude PreToolUse hook: reads one JSON object from stdin, emits updatedInput only
for the two Expert submission tools. Does not approve or deny permissions.
"""
import json
import re
import sys
import uuid

TOOL = re.compile(r"^mcp__teamSkillHub__(?:submit_expert_task_auto|submit_expert_task)$")


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict) or payload.get("hook_event_name") != "PreToolUse":
            return
        if not isinstance(payload.get("tool_name"), str) or not TOOL.fullmatch(payload["tool_name"]):
            return
        provided = payload.get("session_id")
        if not isinstance(provided, str):
            return
        session_id = str(uuid.UUID(provided))
        if provided.lower() != session_id:
            return
        tool_input = payload.get("tool_input")
        if not isinstance(tool_input, dict):
            return
        # Use the authenticated local Claude hook's session identity rather than
        # relying on anything the model may put in the request.
        updated = dict(tool_input)
        updated["clientSessionId"] = session_id
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "updatedInput": updated
        }}, ensure_ascii=False))
    except (ValueError, TypeError, json.JSONDecodeError):
        # A malformed hook must not block unrelated Claude functionality.
        return


if __name__ == "__main__":
    main()
