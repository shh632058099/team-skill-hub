#!/usr/bin/env python3
"""Persist the native Claude user-turn identity and sign Expert submissions."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid

TOOL = re.compile(r"^mcp__teamSkillHub__(?:submit_expert_task_auto|submit_expert_task)$")
DOMAIN = "team-skill-hub/source-request/v1"


def source_request_id(client: str, session_id: str, turn_id: str) -> str:
    material = f"{DOMAIN}\n{client}\n{session_id}\n{turn_id}".encode("utf-8")
    return "srq_" + hashlib.sha256(material).hexdigest()


def state_path(session_id: str) -> Path:
    root = Path(os.environ.get("TEAM_SKILL_HUB_REQUEST_STATE_DIR") or
                Path.home() / ".team-skill-hub" / "request-state" / "claude")
    return root / f"{session_id}.json"


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
            target = state_path(session_id)
            try:
                target.unlink()
            except FileNotFoundError:
                pass
            turn_id = payload.get("prompt_id")
            if not isinstance(turn_id, str) or not turn_id.strip() or len(turn_id) > 200:
                return
            request_id = source_request_id("claude_code", session_id, turn_id.strip())
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(".tmp")
            temporary.write_text(json.dumps({"session_id": session_id, "turn_id": turn_id.strip(),
                                             "source_request_id": request_id}), encoding="utf-8")
            os.chmod(temporary, 0o600)
            temporary.replace(target)
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
        request_id = None
        # Prefer an event-local native turn ID when supplied; otherwise use the
        # latest UserPromptSubmit state for this exact native session.
        turn_id = payload.get("prompt_id") or payload.get("turn_id")
        if isinstance(turn_id, str) and turn_id.strip() and len(turn_id) <= 200:
            request_id = source_request_id("claude_code", session_id, turn_id.strip())
        else:
            try:
                state = json.loads(state_path(session_id).read_text(encoding="utf-8"))
                if state.get("session_id") == session_id and isinstance(state.get("source_request_id"), str):
                    request_id = state["source_request_id"]
            except (OSError, ValueError, TypeError):
                pass
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
        key = tool_input.get("idempotencyKey")
        if request_id:
            updated["sourceRequestId"] = request_id
        if credential and isinstance(key, str):
            timestamp = str(int(time.time() * 1000))
            if request_id:
                message = f"team-skill-hub/client-session/v2\n{session_id}\n{request_id}\n{key}\n{timestamp}"
            else:
                message = f"team-skill-hub/client-session/v1\n{session_id}\n{key}\n{timestamp}"
            signature = hmac.new(credential.encode(), message.encode(), hashlib.sha256).hexdigest()
            updated["clientSessionProof"] = f"{timestamp}.{signature}"
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": updated}}, ensure_ascii=False))
    except (ValueError, TypeError, json.JSONDecodeError):
        return


if __name__ == "__main__":
    main()
