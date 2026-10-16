# Project Working Agreement

For this `team-skill-hub` project, when the user reports a problem or asks for a bug investigation:

1. Investigate first and confirm the root cause with evidence.
2. Report the diagnosis and recommended fix to the user before making changes.
3. Do not modify code, configuration, deployment state, Git history, or remote repositories until the user explicitly confirms the proposed fix.
4. Read-only inspection, diagnostics, reproduction, logs, and tests that do not mutate project/runtime state are allowed before confirmation.
5. After confirmation, make only the agreed changes, then verify them and report the result.

For substantial design, implementation, and debugging work, prefer the Superpowers workflow and its relevant skills before ad-hoc changes:

- Design / feature shaping: use `brainstorming` first, and `writing-plans` for multi-step implementation plans.
- Implementation: use `executing-plans` and `test-driven-development` where applicable.
- Debugging / unexpected failures: use `systematic-debugging` before proposing fixes.
- Before declaring completion or preparing Git integration: use `verification-before-completion`, and request/review code review when appropriate.
- These Superpowers workflows do not override the confirmation gate above: investigate and report first; only mutate the project after the user confirms the proposed fix.

This rule takes precedence over the project's normal preference for direct execution when the task is a problem/bug investigation.
