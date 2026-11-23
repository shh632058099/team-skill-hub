# Workflow Verification Routing Design

## Intent

Prevent read-only Work such as code-line counting, search, inspection, and analysis from being treated as code modification work, while keeping strict build/test verification for real code changes.

## Decisions

1. Workflow owns whether repository verification is required; repository configuration only owns how code-change verification is executed.
2. MCP `submit_work` defaults an omitted `workflowId` to `investigation`. The lower-level orchestration-store fallback remains `code-fix-default` for legacy/non-MCP callers; repository defaults remain available to those callers.
3. A readonly Workflow does not inherit repository `verificationPolicy` steps. Workflow-local `validation.required` steps still run if explicitly configured.
4. A `code_change` Workflow continues to merge Workflow `validation.required` with repository `verificationPolicy` and still requires concrete build + unit-test verification.
5. Verification infrastructure failures (exit code 127 or `VERIFICATION_PROCESS_FAILED`) block the Work as `verification_environment` instead of scheduling an Agent continuation.
6. Ordinary verification failures can still request continuation because the Agent may need to fix code.
7. Reaching `maxTurnsPerRun` transitions the Work to `blocked` with `continuation_limit` instead of throwing while leaving `status=running`.

## Non-goals

- Natural-language classification of arbitrary work into bug-fix vs feature-change.
- Changing repository verification command definitions.
- Changing review/publication semantics for code_change workflows.
- Automatically resuming blocked Work after environment fixes.

## Expected flow

Readonly:
submit_work(no workflow) -> investigation -> read-only deployment -> no repository build/test -> Expert result -> completed.

Code change:
submit_work(workflowId=bug-fix/feature-change/...) -> code_change -> repository build/test -> review/publication gates.

Failure:
verification exit 127/process failure -> blocked(verification_environment).
continuation budget exhausted -> blocked(continuation_limit).
