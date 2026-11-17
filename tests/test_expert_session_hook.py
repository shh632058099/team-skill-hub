import json
import os
import tempfile
import subprocess
import sys
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / 'scripts/claude/expert-session-hook.py'
SESSION = '57fa17ba-1e37-4f5d-b504-d7aa9c3c89df'


def invoke(payload, env=None):
    return subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )


def apply(payload):
    p = invoke(payload)
    p.check_returncode()
    return json.loads(p.stdout) if p.stdout else None


class SessionHookTests(unittest.TestCase):
    def test_work_tools_get_native_session_and_proof_bound_to_correct_key(self):
        with tempfile.TemporaryDirectory() as state_dir:
            env = dict(os.environ, TEAM_SKILL_HUB_REQUEST_STATE_DIR=state_dir, TEAM_SKILL_HUB_API_KEY='hook-secret')
            for tool_name, tool_input in (
                ('submit_work', {'title': 'x', 'description': 'y', 'idempotencyKey': 'work-key'}),
                ('update_work_source', {'workItemId': '11111111-1111-4111-8111-111111111111', 'state': 'terminal'}),
            ):
                payload = {'hook_event_name': 'PreToolUse', 'tool_name': f'mcp__teamSkillHub__{tool_name}',
                           'session_id': SESSION, 'tool_input': tool_input}
                p = invoke(payload, env)
                self.assertEqual(p.returncode, 0, p.stderr)
                updated = json.loads(p.stdout)['hookSpecificOutput']['updatedInput']
                self.assertEqual(updated['clientSessionId'], SESSION)
                self.assertRegex(updated['clientSessionProof'], r'^\d{13}\.[a-f0-9]{64}$')

    def test_deprecated_expert_submit_tools_are_not_intercepted(self):
        for name in ('submit_expert_task', 'submit_expert_task_auto'):
            with self.subTest(name=name):
                self.assertIsNone(apply({'hook_event_name': 'PreToolUse',
                    'tool_name': f'mcp__teamSkillHub__{name}', 'session_id': SESSION,
                    'tool_input': {'problem': 'legacy', 'idempotencyKey': 'k'}}))

    def test_user_prompt_and_other_tools_are_untouched(self):
        self.assertIsNone(apply({'hook_event_name': 'UserPromptSubmit', 'session_id': SESSION, 'prompt_id': 'turn-1'}))
        for tool in ('Bash', 'mcp__teamSkillHub__wait_work', 'mcp__other__submit_work'):
            self.assertIsNone(apply({'hook_event_name':'PreToolUse','tool_name': tool,
                'session_id': SESSION,'tool_input': {}}))

    def test_matched_work_tool_fails_closed_on_bad_session_input_or_credential(self):
        cases = (
            (
                {'hook_event_name': 'PreToolUse', 'tool_name': 'mcp__teamSkillHub__submit_work',
                 'session_id': '../../bad', 'tool_input': {'idempotencyKey': 'k'}},
                'INVALID_SESSION_ID',
                dict(os.environ, TEAM_SKILL_HUB_API_KEY='hook-secret'),
            ),
            (
                {'hook_event_name': 'PreToolUse', 'tool_name': 'mcp__teamSkillHub__submit_work',
                 'session_id': SESSION, 'tool_input': None},
                'INVALID_TOOL_INPUT',
                dict(os.environ, TEAM_SKILL_HUB_API_KEY='hook-secret'),
            ),
            (
                {'hook_event_name': 'PreToolUse', 'tool_name': 'mcp__teamSkillHub__submit_work',
                 'session_id': SESSION, 'tool_input': {'title': 'x'}},
                'MISSING_BINDING_KEY',
                dict(os.environ, TEAM_SKILL_HUB_API_KEY='hook-secret'),
            ),
        )
        for payload, code, env in cases:
            with self.subTest(code=code):
                p = invoke(payload, env)
                self.assertEqual(p.returncode, 2)
                self.assertIn(f'TEAM_SKILL_HUB_WORK_HOOK_ERROR:{code}', p.stderr)
                self.assertEqual(p.stdout, '')

        env = dict(os.environ)
        env.pop('TEAM_SKILL_HUB_API_KEY', None)
        p = invoke(
            {'hook_event_name': 'PreToolUse', 'tool_name': 'mcp__teamSkillHub__submit_work',
             'session_id': SESSION, 'tool_input': {'idempotencyKey': 'k'}},
            env,
        )
        self.assertEqual(p.returncode, 2)
        self.assertIn('TEAM_SKILL_HUB_WORK_HOOK_ERROR:CREDENTIAL_UNAVAILABLE', p.stderr)
        self.assertEqual(p.stdout, '')


if __name__ == '__main__':
    unittest.main()
