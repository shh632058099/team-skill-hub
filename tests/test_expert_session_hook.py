import json
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
    def test_both_submit_tools_get_native_session(self):
        for name in ('submit_expert_task', 'submit_expert_task_auto'):
            with self.subTest(name=name):
                result = apply({'hook_event_name': 'PreToolUse',
                    'tool_name': f'mcp__teamSkillHub__{name}', 'session_id': SESSION,
                    'tool_input': {'problem': 'read-only', 'idempotencyKey': 'k', 'clientSessionId': 'old'}})
                self.assertEqual(result['hookSpecificOutput']['updatedInput'],
                    {'problem': 'read-only', 'idempotencyKey': 'k', 'clientSessionId': SESSION})
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
