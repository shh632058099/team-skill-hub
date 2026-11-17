#!/usr/bin/env python3
"""Bind Team Skill Hub Work tools to the native Codex session and user turn."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid

DOMAIN = "team-skill-hub/source-request/v1"


def configuration() -> tuple[str, str]:
    config_path = Path(
        os.environ.get("TEAM_SKILL_HUB_HOOK_CONFIG")
        or Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "hooks" / "team-skill-hub.conf"
    )
    server_name = "teamSkillHub"
    key_env = "TEAM_SKILL_HUB_API_KEY"
    if config_path.is_file():
        for line in config_path.read_text(encoding="utf-8").splitlines():
            name, separator, value = line.partition("=")
            if not separator:
                continue
            if name == "server_name" and re.fullmatch(r"[A-Za-z0-9_-]+", value.strip()):
                server_name = value.strip()
            elif name == "api_key_env" and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value.strip()):
                key_env = value.strip()
    return server_name, key_env


def emit(decision: str, reason: str | None = None, updated: dict | None = None) -> None:
    output = {"hookEventName": "PreToolUse", "permissionDecision": decision}
    if reason:
        output["permissionDecisionReason"] = reason
    if updated is not None:
        output["updatedInput"] = updated
    print(json.dumps({"hookSpecificOutput": output}, ensure_ascii=False, separators=(",", ":")))


def native_turn_token(payload: dict) -> str | None:
    for key in ("turn_id", "prompt_id"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip() and len(value.strip()) <= 200:
            return value.strip()
    return None


def source_request_id(session_id: str, turn_token: str) -> str:
    material = f"{DOMAIN}\ncodex\n{session_id}\n{turn_token}".encode()
    return "srq_" + hashlib.sha256(material).hexdigest()


def state_path(session_id: str) -> Path:
    root = Path(
        os.environ.get("TEAM_SKILL_HUB_REQUEST_STATE_DIR")
        or Path.home() / ".team-skill-hub" / "request-state" / "codex"
    )
    return root / f"{session_id}.json"


def persist_request_state(session_id: str, payload: dict) -> None:
    token = native_turn_token(payload) or f"generated:{uuid.uuid4()}"
    request_id = source_request_id(session_id, token)
    target = state_path(session_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f"{target.name}.tmp-{os.getpid()}")
    temporary.write_text(
        json.dumps({"session_id": session_id, "turn_token": token, "source_request_id": request_id}),
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    temporary.replace(target)


def load_source_request_id(session_id: str, payload: dict) -> str | None:
    token = native_turn_token(payload)
    if token:
        return source_request_id(session_id, token)
    try:
        state = json.loads(state_path(session_id).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, UnicodeError):
        return None
    request_id = state.get("source_request_id")
    if state.get("session_id") == session_id and isinstance(request_id, str) and re.fullmatch(r"srq_[a-f0-9]{64}", request_id):
        return request_id
    return None


def main() -> None:
    payload = None
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            return
        event = payload.get("hook_event_name")
        try:
            provided_session = payload.get("session_id")
            session_id = str(uuid.UUID(provided_session))
            if provided_session.lower() != session_id:
                raise ValueError("non-canonical session UUID")
        except (ValueError, TypeError, AttributeError):
            return

        if event == "UserPromptSubmit":
            persist_request_state(session_id, payload)
            return
        if event != "PreToolUse":
            return

        tool_name = payload.get("tool_name")
        server_name, key_env = configuration()
        allowed_tools = {
            f"mcp__{server_name}__submit_work",
            f"mcp__{server_name}__update_work_source",
        }
        if tool_name not in allowed_tools:
            return

        tool_input = payload.get("tool_input")
        if not isinstance(tool_input, dict):
            emit("deny", "Team Skill Hub cannot attach the native Codex session identity; submission was blocked.")
            return
        is_update = tool_name == f"mcp__{server_name}__update_work_source"
        binding_key = tool_input.get("workItemId") if is_update else tool_input.get("idempotencyKey")
        if not isinstance(binding_key, str) or not binding_key.strip():
            emit("deny", "Team Skill Hub requires a stable binding key before session identity can be attached.")
            return

        credential = os.environ.get(key_env, "")
        if not credential:
            emit("deny", f"Team Skill Hub cannot sign the Codex session proof because {key_env} is unavailable.")
            return

        timestamp = str(int(time.time() * 1000))
        updated = dict(tool_input)
        updated.pop("sourceRequestId", None)
        updated.pop("clientSessionProof", None)
        updated["clientSessionId"] = session_id

        if is_update:
            message = f"team-skill-hub/client-session/v1\n{session_id}\n{binding_key}\n{timestamp}"
        else:
            request_id = load_source_request_id(session_id, payload)
            if not request_id:
                emit("deny", "Team Skill Hub cannot identify the current native user turn; submit_work was blocked.")
                return
            updated["sourceRequestId"] = request_id
            message = (
                f"team-skill-hub/client-session/v2\n{session_id}\n{request_id}\n"
                f"{binding_key}\n{timestamp}"
            )

        signature = hmac.new(credential.encode(), message.encode(), hashlib.sha256).hexdigest()
        updated["clientSessionProof"] = f"{timestamp}.{signature}"
        emit("allow", updated=updated)
    except Exception:
        if isinstance(payload, dict) and payload.get("hook_event_name") == "PreToolUse":
            tool_name = payload.get("tool_name")
            if isinstance(tool_name, str) and tool_name.endswith(("__submit_work", "__update_work_source")):
                emit("deny", "Team Skill Hub could not safely attach the native Codex session identity; submission was blocked.")
        return


if __name__ == "__main__":
    main()
