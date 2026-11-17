#!/usr/bin/env python3
"""Bind Team Skill Hub Work tools to the native Claude session and user turn."""
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
DOMAIN = "team-skill-hub/source-request/v1"


class WorkHookError(Exception):
    pass


def fail(code: str) -> None:
    print(f"TEAM_SKILL_HUB_WORK_HOOK_ERROR:{code}", file=sys.stderr)
    raise SystemExit(2)


def canonical_session(payload: dict) -> str:
    provided = payload.get("session_id")
    if not isinstance(provided, str):
        raise WorkHookError("INVALID_SESSION_ID")
    try:
        session_id = str(uuid.UUID(provided))
    except ValueError as error:
        raise WorkHookError("INVALID_SESSION_ID") from error
    if provided != session_id:
        raise WorkHookError("NON_CANONICAL_SESSION_ID")
    return session_id


def state_path(session_id: str) -> Path:
    root = Path(
        os.environ.get("TEAM_SKILL_HUB_REQUEST_STATE_DIR")
        or Path.home() / ".team-skill-hub" / "request-state" / "claude"
    )
    return root / f"{session_id}.json"


def native_turn_token(payload: dict) -> str | None:
    for key in ("prompt_id", "turn_id"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip() and len(value.strip()) <= 200:
            return value.strip()
    return None


def source_request_id(session_id: str, turn_token: str) -> str:
    material = f"{DOMAIN}\nclaude_code\n{session_id}\n{turn_token}".encode("utf-8")
    return "srq_" + hashlib.sha256(material).hexdigest()


def persist_request_state(session_id: str, payload: dict) -> None:
    token = native_turn_token(payload) or f"generated:{uuid.uuid4()}"
    request_id = source_request_id(session_id, token)
    target = state_path(session_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f"{target.name}.tmp-{os.getpid()}")
    temporary.write_text(
        json.dumps(
            {"session_id": session_id, "turn_token": token, "source_request_id": request_id},
            ensure_ascii=False,
        ),
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
    if state.get("session_id") != session_id:
        return None
    request_id = state.get("source_request_id")
    return request_id if isinstance(request_id, str) and re.fullmatch(r"srq_[a-f0-9]{64}", request_id) else None


def credential_env() -> str:
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
    return key_env


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

    event = payload.get("hook_event_name")
    if event == "UserPromptSubmit":
        try:
            persist_request_state(canonical_session(payload), payload)
        except WorkHookError:
            return
        except Exception:
            return
        return
    if event != "PreToolUse":
        return
    tool_name = payload.get("tool_name")
    if not isinstance(tool_name, str) or not TOOL.fullmatch(tool_name):
        return

    try:
        session_id = canonical_session(payload)
        tool_input = payload.get("tool_input")
        if not isinstance(tool_input, dict):
            raise WorkHookError("INVALID_TOOL_INPUT")
        updated = dict(tool_input)
        is_update = tool_name.endswith("__update_work_source")
        binding_key = tool_input.get("workItemId") if is_update else tool_input.get("idempotencyKey")
        if not isinstance(binding_key, str) or not binding_key.strip():
            raise WorkHookError("MISSING_BINDING_KEY")

        key_env = credential_env()
        credential = os.environ.get(key_env, "")
        if not credential:
            raise WorkHookError("CREDENTIAL_UNAVAILABLE")

        updated["clientSessionId"] = session_id
        updated.pop("clientSessionProof", None)
        updated.pop("sourceRequestId", None)
        timestamp = str(int(time.time() * 1000))

        if is_update:
            message = f"team-skill-hub/client-session/v1\n{session_id}\n{binding_key}\n{timestamp}"
        else:
            request_id = load_source_request_id(session_id, payload)
            if not request_id:
                raise WorkHookError("SOURCE_REQUEST_UNAVAILABLE")
            updated["sourceRequestId"] = request_id
            message = (
                f"team-skill-hub/client-session/v2\n{session_id}\n{request_id}\n"
                f"{binding_key}\n{timestamp}"
            )

        signature = hmac.new(credential.encode(), message.encode(), hashlib.sha256).hexdigest()
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
