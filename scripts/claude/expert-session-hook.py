#!/usr/bin/env python3
"""Attach the native Claude session identity to Team Skill Hub Work tools."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid

TOOL = re.compile(r"^mcp__teamSkillHub__(?:submit_work|update_work_source)$")


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            return
        event = payload.get("hook_event_name")
        provided = payload.get("session_id")
        if not isinstance(provided, str):
            return
        session_id = str(uuid.UUID(provided))
        if provided.lower() != session_id:
            return

        if event == "UserPromptSubmit":
            return
        if event != "PreToolUse" or not isinstance(payload.get("tool_name"), str) or not TOOL.fullmatch(payload["tool_name"]):
            return
        tool_input = payload.get("tool_input")
        if not isinstance(tool_input, dict):
            return
        updated = dict(tool_input)
        updated["clientSessionId"] = session_id
        updated.pop("clientSessionProof", None)
        updated.pop("sourceRequestId", None)
        binding_key = tool_input.get("idempotencyKey") if not payload["tool_name"].endswith("__update_work_source") else tool_input.get("workItemId")
        config_path = Path(os.environ.get("TEAM_SKILL_HUB_HOOK_CONFIG") or
                           Path(__file__).resolve().parent / "team-skill-hub.conf")
        key_env = "TEAM_SKILL_HUB_API_KEY"
        if config_path.is_file():
            for line in config_path.read_text(encoding="utf-8").splitlines():
                if line.startswith("api_key_env="):
                    candidate = line.partition("=")[2].strip()
                    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", candidate):
                        key_env = candidate
        credential = os.environ.get(key_env, "")
        if credential and isinstance(binding_key, str):
            timestamp = str(int(time.time() * 1000))
            message = f"team-skill-hub/client-session/v1\n{session_id}\n{binding_key}\n{timestamp}"
            signature = hmac.new(credential.encode(), message.encode(), hashlib.sha256).hexdigest()
            updated["clientSessionProof"] = f"{timestamp}.{signature}"
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": updated}}, ensure_ascii=False))
    except (ValueError, TypeError, json.JSONDecodeError):
        return


if __name__ == "__main__":
    main()
