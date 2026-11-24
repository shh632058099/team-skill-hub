# Workflow Selection Catalog Design

## Intent

Make Team Skill Hub the source of truth for Workflow selection semantics while keeping Claude/Codex responsible for understanding the user's request.

The client must select a Workflow by the user's **primary requested outcome**, not by incidental verification failures or secondary activities. The Hub owns the current catalog and the semantic metadata for each Workflow.

## Goals

- Store Workflow selection semantics with the versioned Workflow definition.
- Expose the current selectable Workflow catalog over MCP.
- Keep existing persisted and custom Workflows backward compatible.
- Keep omission of `submit_work.workflowId` fail-safe: MCP omission still means `investigation`.
- Make Claude and Codex use the same primary-outcome rule.
- Allow future custom Workflows to become discoverable without requiring a client release.

## Non-goals

- No server-side NLP classifier.
- No automatic server-side replacement of an explicitly supplied Workflow.
- No keyword-based routing table in the Hub.
- No database migration or second Workflow-selection table.
- No change to Expert/Deployment routing semantics.

## Approach

### Versioned selection metadata

Add optional metadata to `WorkflowDefinition`:

```ts
selection?: {
  summary: string;
  useWhen: string[];
  notWhen: string[];
};
```

It is optional for backward compatibility with already persisted and custom Workflows. New built-in presets publish new immutable versions carrying this metadata.

### Built-in semantics

The latest built-ins describe these primary outcomes:

- `investigation`: readonly analysis/search/statistics/diagnosis/code inspection.
- `code-review`: readonly review and findings.
- `bug-fix`: fix incorrect existing runtime/business behavior.
- `feature-change`: implement new or changed externally observable behavior.
- `refactor`: restructure code without intended behavior change.
- `test-improvement`: tests/test infrastructure are the primary deliverable.
- `build-fix`: build/link/CI buildability is the primary deliverable.
- `release-change`: version/package/release/publishing is the primary deliverable.

Secondary work does not override the primary outcome. Examples:

- feature work that currently fails to build remains `feature-change`.
- a runtime bug exposed by a failing test remains `bug-fix`.
- adding tests alongside a new feature remains `feature-change`.

### Catalog API

Add MCP `list_workflows`. It returns one record per Workflow ID, using the latest version only:

- `workflowId`
- `version`
- `changeMode`
- `delivery` when present
- `summary`
- `useWhen`
- `notWhen`
- `selectionConfigured`

The response also states the global selection rule: choose by primary requested outcome; verification symptoms and secondary activities do not change the Workflow.

Legacy/custom Workflows without selection metadata remain visible. Their summary falls back to a neutral generated description and `selectionConfigured=false`.

`code-fix-default` remains an internal compatibility fallback and is not advertised as a selectable client Workflow.

### Client integration

Claude/Codex guidance becomes generic:

1. Choose Workflow by primary requested outcome.
2. Omit `workflowId` only for clearly readonly investigation/search/statistics/code-inspection work.
3. For repository modifications, explicitly choose a code-change Workflow.
4. If the intent is ambiguous or a custom Workflow may fit better, call `list_workflows` before `submit_work`.
5. Incidental build/test failures do not change the Workflow chosen for the primary task.

The client guidance does not duplicate the full built-in catalog.

## Compatibility and safety

- Existing Workflow rows continue to normalize because `selection` is optional.
- Existing custom Workflows remain valid.
- Existing explicit `workflowId` submissions are unchanged.
- MCP omission still defaults to `investigation`.
- Readonly/code-change execution and verification behavior are unchanged.
- The Hub never silently upgrades or substitutes an explicitly supplied Workflow.

## Validation

- Store tests cover metadata validation, latest-version catalog ordering, hidden compatibility fallback, and legacy metadata absence.
- MCP E2E proves `list_workflows` exists and returns built-in latest semantics plus custom Workflows.
- Client integration tests prove Claude/Codex instructions reference primary outcome and `list_workflows` rather than hard-coding the catalog as the source of truth.
- Full TypeScript test suite, typecheck/lint/format checks pass.
