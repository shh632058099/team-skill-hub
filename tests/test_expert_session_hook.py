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
    def test_user_prompt_submit_identity_is_reused_for_pretooluse_and_signed_v2(self):
        with tempfile.TemporaryDirectory() as state_dir:
            env = dict(os.environ, TEAM_SKILL_HUB_REQUEST_STATE_DIR=state_dir, TEAM_SKILL_HUB_API_KEY='hook-secret')
            prompt = {'hook_event_name': 'UserPromptSubmit', 'session_id': SESSION, 'prompt_id': 'prompt-native-1', 'prompt': 'private text'}
            subprocess.run([sys.executable, str(HOOK)], input=json.dumps(prompt), text=True, capture_output=True, check=True, env=env)
            payload = {'hook_event_name': 'PreToolUse', 'tool_name': 'mcp__teamSkillHub__submit_expert_task_auto',
                       'session_id': SESSION, 'tool_input': {'problem': 'changed wording', 'idempotencyKey': 'new-key'}}
            p = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), text=True, capture_output=True, check=True, env=env)
            updated = json.loads(p.stdout)['hookSpecificOutput']['updatedInput']
            self.assertRegex(updated['sourceRequestId'], r'^srq_[a-f0-9]{64}$')
            self.assertEqual(updated['clientSessionId'], SESSION)
            self.assertRegex(updated['clientSessionProof'], r'^\d{13}\.[a-f0-9]{64}$')
            replay = dict(payload, tool_input={'problem': 'different wording', 'idempotencyKey': 'another-key'})
            p2 = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(replay), text=True, capture_output=True, check=True, env=env)
            updated2 = json.loads(p2.stdout)['hookSpecificOutput']['updatedInput']
            self.assertEqual(updated2['sourceRequestId'], updated['sourceRequestId'])
            next_prompt = dict(prompt, prompt_id='prompt-native-2')
            subprocess.run([sys.executable, str(HOOK)], input=json.dumps(next_prompt), text=True, capture_output=True, check=True, env=env)
            p3 = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), text=True, capture_output=True, check=True, env=env)
            updated3 = json.loads(p3.stdout)['hookSpecificOutput']['updatedInput']
            self.assertNotEqual(updated3['sourceRequestId'], updated['sourceRequestId'])
            self.assertEqual(len(list(Path(state_dir).glob('*.json'))), 1)

    def test_new_prompt_without_prompt_id_clears_previous_request_state(self):
        with tempfile.TemporaryDirectory() as state_dir:
            env = dict(os.environ, TEAM_SKILL_HUB_REQUEST_STATE_DIR=state_dir, TEAM_SKILL_HUB_API_KEY='hook-secret')
            first = {'hook_event_name': 'UserPromptSubmit', 'session_id': SESSION, 'prompt_id': 'prompt-native-1'}
            subprocess.run([sys.executable, str(HOOK)], input=json.dumps(first), text=True, capture_output=True, check=True, env=env)
            missing_id = {'hook_event_name': 'UserPromptSubmit', 'session_id': SESSION, 'prompt': 'new prompt without native id'}
            subprocess.run([sys.executable, str(HOOK)], input=json.dumps(missing_id), text=True, capture_output=True, check=True, env=env)
            submit = {'hook_event_name': 'PreToolUse', 'tool_name': 'mcp__teamSkillHub__submit_expert_task_auto',
                      'session_id': SESSION, 'tool_input': {'problem': 'new request', 'idempotencyKey': 'new'}}
            p = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(submit), text=True, capture_output=True, check=True, env=env)
            updated = json.loads(p.stdout)['hookSpecificOutput']['updatedInput']
            self.assertNotIn('sourceRequestId', updated)
            self.assertIn('clientSessionProof', updated)

    def test_both_submit_tools_get_native_session(self):
        for name in ('submit_expert_task', 'submit_expert_task_auto'):
            with self.subTest(name=name):
                result = apply({'hook_event_name': 'PreToolUse',
                    'tool_name': f'mcp__teamSkillHub__{name}', 'session_id': SESSION,
                    'tool_input': {'problem': 'read-only', 'idempotencyKey': 'k', 'clientSessionId': 'old'}})
                updated = result['hookSpecificOutput']['updatedInput']
                self.assertEqual(updated['clientSessionId'], SESSION)
                self.assertEqual(updated['problem'], 'read-only')
                self.assertEqual(updated['idempotencyKey'], 'k')
                self.assertNotIn('permissionDecision', result['hookSpecificOutput'])

    def test_other_tools_and_invalid_session_are_untouched(self):
        for tool in ('Bash', 'mcp__teamSkillHub__wait_expert_task', 'mcp__other__submit_expert_task_auto'):
            self.assertIsNone(apply({'hook_event_name':'PreToolUse','tool_name': tool,
                'session_id': SESSION,'tool_input': {}}))
        self.assertIsNone(apply({'hook_event_name': 'PreToolUse',
            'tool_name': 'mcp__teamSkillHub__submit_expert_task_auto',
            'session_id': '../../bad', 'tool_input': {'problem': 'x'}}))

    def test_different_conversations_preserve_distinct_ids(self):
        values=[]
        for sid in (SESSION, 'eac7bfb7-4dfa-46a3-ab19-f283991f9161'):
            x=apply({'hook_event_name':'PreToolUse', 'tool_name':'mcp__teamSkillHub__submit_expert_task_auto',
                'session_id':sid, 'tool_input':{'problem':'same'}})
            values.append(x['hookSpecificOutput']['updatedInput']['clientSessionId'])
        self.assertNotEqual(*values)


if __name__ == '__main__':
    unittest.main()
