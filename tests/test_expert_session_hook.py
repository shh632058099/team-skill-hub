import json
import os
import tempfile
import subprocess
import sys
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / 'scripts/claude/expert-session-hook.py'
SESSION = '57fa17ba-1e37-4f5d-b504-d7aa9c3c89df'


def apply(payload):
    p = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload),
                       text=True, capture_output=True, check=True)
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
                p = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), text=True,
                                   capture_output=True, check=True, env=env)
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
        self.assertIsNone(apply({'hook_event_name': 'PreToolUse',
            'tool_name': 'mcp__teamSkillHub__submit_work',
            'session_id': '../../bad', 'tool_input': {'title': 'x', 'description': 'y', 'idempotencyKey': 'k'}}))

if __name__ == '__main__':
    unittest.main()
