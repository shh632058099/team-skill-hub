#!/usr/bin/env python3
"""Inject Codex's native thread/session UUID into Team Skill Hub submit calls."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid


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
        state_root = Path(os.environ.get("TEAM_SKILL_HUB_REQUEST_STATE_DIR") or Path.home() / ".team-skill-hub" / "request-state" / "codex")
        state_path = state_root / f"{session_id}.json"
        if event == "UserPromptSubmit":
            try:
                state_path.unlink()
            except FileNotFoundError:
                pass
            turn_id = payload.get("turn_id")
            if isinstance(turn_id, str) and turn_id.strip() and len(turn_id) <= 200:
                material = f"team-skill-hub/source-request/v1\ncodex\n{session_id}\n{turn_id.strip()}".encode()
                request_id = "srq_" + hashlib.sha256(material).hexdigest()
                state_root.mkdir(parents=True, exist_ok=True)
                temporary = state_path.with_suffix(".tmp")
                temporary.write_text(json.dumps({"session_id": session_id, "turn_id": turn_id.strip(), "source_request_id": request_id}), encoding="utf-8")
                os.chmod(temporary, 0o600)
                temporary.replace(state_path)
            return
        if event != "PreToolUse":
            return
        tool_name = payload.get("tool_name")
        server_name, key_env = configuration()
        allowed_tools = {
            f"mcp__{server_name}__submit_expert_task",
            f"mcp__{server_name}__submit_expert_task_auto",
        }
        if tool_name not in allowed_tools:
            return

        tool_input = payload.get("tool_input")
        if not isinstance(tool_input, dict):
            emit("deny", "Team Skill Hub cannot attach the native Codex session identity; submission was blocked.")
            return
        idempotency_key = tool_input.get("idempotencyKey")
        if not isinstance(idempotency_key, str) or not idempotency_key.strip():
            emit("deny", "Team Skill Hub requires an idempotencyKey before session identity can be attached.")
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
        turn_id = payload.get("turn_id")
        source_request_id = None
        if isinstance(turn_id, str) and turn_id.strip() and len(turn_id) <= 200:
            material = f"team-skill-hub/source-request/v1\ncodex\n{session_id}\n{turn_id.strip()}".encode()
            source_request_id = "srq_" + hashlib.sha256(material).hexdigest()
        else:
            try:
                state = json.loads(state_path.read_text(encoding="utf-8"))
                if state.get("session_id") == session_id:
                    source_request_id = state.get("source_request_id")
            except (OSError, ValueError, TypeError):
                pass
        if isinstance(source_request_id, str) and re.fullmatch(r"srq_[a-f0-9]{64}", source_request_id):
            updated["sourceRequestId"] = source_request_id
        else:
            source_request_id = None
        if source_request_id:
            message = f"team-skill-hub/client-session/v2\n{session_id}\n{source_request_id}\n{idempotency_key}\n{timestamp}"
        else:
            message = f"team-skill-hub/client-session/v1\n{session_id}\n{idempotency_key}\n{timestamp}"
        signature = hmac.new(credential.encode(), message.encode(), hashlib.sha256).hexdigest()
        updated["clientSessionProof"] = f"{timestamp}.{signature}"
        emit("allow", updated=updated)
    except Exception:
        # Never allow a target submission through without a verified session proof.
        if isinstance(payload, dict) and payload.get("hook_event_name") == "PreToolUse":
            tool_name = payload.get("tool_name")
            if isinstance(tool_name, str) and tool_name.endswith(("__submit_expert_task", "__submit_expert_task_auto")):
                emit("deny", "Team Skill Hub could not safely attach the native Codex session identity; submission was blocked.")
        # A malformed hook event must not interrupt unrelated Codex operations.
        return


if __name__ == "__main__":
    main()
