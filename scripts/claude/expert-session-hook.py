#!/usr/bin/env python3
"""Bind Team Skill Hub Work tools to the native Claude session."""
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


class WorkHookError(Exception):
    pass


def fail(code: str) -> None:
    print(f"TEAM_SKILL_HUB_WORK_HOOK_ERROR:{code}", file=sys.stderr)
    raise SystemExit(2)


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        fail("EMPTY_INPUT")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        fail("INVALID_JSON")
    if not isinstance(payload, dict):
        fail("INVALID_JSON")

    if payload.get("hook_event_name") != "PreToolUse":
        return
    tool_name = payload.get("tool_name")
    if not isinstance(tool_name, str) or not TOOL.fullmatch(tool_name):
        return

    try:
        provided = payload.get("session_id")
        if not isinstance(provided, str):
            raise WorkHookError("INVALID_SESSION_ID")
        try:
            session_id = str(uuid.UUID(provided))
        except ValueError as error:
            raise WorkHookError("INVALID_SESSION_ID") from error
        if provided != session_id:
            raise WorkHookError("NON_CANONICAL_SESSION_ID")

        tool_input = payload.get("tool_input")
        if not isinstance(tool_input, dict):
            raise WorkHookError("INVALID_TOOL_INPUT")
        updated = dict(tool_input)
        binding_key = (
            tool_input.get("workItemId")
            if tool_name.endswith("__update_work_source")
            else tool_input.get("idempotencyKey")
        )
        if not isinstance(binding_key, str) or not binding_key.strip():
            raise WorkHookError("MISSING_BINDING_KEY")

        config_path = Path(
            os.environ.get("TEAM_SKILL_HUB_HOOK_CONFIG")
            or Path(__file__).resolve().parent / "team-skill-hub.conf"
        )
        key_env = "TEAM_SKILL_HUB_API_KEY"
        if config_path.is_file():
            try:
                lines = config_path.read_text(encoding="utf-8").splitlines()
            except (OSError, UnicodeError) as error:
                raise WorkHookError("CONFIG_READ_FAILED") from error
            for line in lines:
                if line.startswith("api_key_env="):
                    candidate = line.partition("=")[2].strip()
                    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", candidate):
                        key_env = candidate

        credential = os.environ.get(key_env, "")
        if not credential:
            raise WorkHookError("CREDENTIAL_UNAVAILABLE")

        timestamp = str(int(time.time() * 1000))
        message = f"team-skill-hub/client-session/v1\n{session_id}\n{binding_key}\n{timestamp}"
        signature = hmac.new(credential.encode(), message.encode(), hashlib.sha256).hexdigest()
        updated["clientSessionId"] = session_id
        updated.pop("clientSessionProof", None)
        updated.pop("sourceRequestId", None)
        updated["clientSessionProof"] = f"{timestamp}.{signature}"
        print(
            json.dumps(
                {"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": updated}},
                ensure_ascii=False,
            )
        )
    except WorkHookError as error:
        fail(str(error))
    except Exception:
        fail("PROCESSING_FAILED")


if __name__ == "__main__":
    main()
