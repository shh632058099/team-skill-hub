# Knowledge Submission Spec Design

## Goal

Make Team Skill Hub the single source of truth for Knowledge submission rules. Codex/Claude clients, Admin-created candidates, and automatic server-side candidates must all use the same versioned server-side Knowledge Submission Spec and the same validation/normalization path.

## Current problems

The current Knowledge format is duplicated across client guidance, setup scripts, developer documentation, MCP tool descriptions, and the server parser. This already causes drift: the server parser accepts Knowledge summaries up to 50,000 characters while the MCP `submit_knowledge_candidate` schema currently limits `content` to 10,000 characters.

Manual/MCP submissions and automatic candidates also follow different paths. `manual` and `mcp-session` Knowledge submissions are normalized by `normalizeKnowledgeCandidateSummary()`, while `codex-summary` automatic candidates can call `observability.createCandidate()` directly with an excerpt and bypass the Knowledge summary contract entirely.

## Design principles

1. The server owns the Knowledge submission contract.
2. Clients know when to submit Knowledge, but not the concrete section layout or limits.
3. The current spec is discoverable through MCP before a model submits Knowledge.
4. Every Knowledge Candidate path uses one server-side validator/normalizer.
5. The server always validates submissions; a client-provided spec version is evidence, not trust.
6. Spec edits are runtime configuration changes and do not require rebuilding the server or upgrading client integration.
7. Spec history is immutable and auditable. Rollback creates a new version copied from an older version; version numbers never move backward.
8. First implementation uses one global Knowledge Submission Spec. Repository/project-specific overrides are explicitly out of scope, but MCP/API shapes may accept an optional repository selector for future compatibility.

## Architecture

Introduce a focused Knowledge submission subsystem:

- `KnowledgeSubmissionSpecStore`: loads the built-in default spec, persists server-edited versions, exposes the current spec and immutable history, creates new versions, and performs rollback-by-copy.
- `KnowledgeSubmissionService`: renders the model-facing template/instruction, validates and normalizes Knowledge submissions against the current spec, and returns canonical Knowledge content.
- `KnowledgeCandidateService` behavior inside the application service: all Knowledge Candidate creation paths call the submission service before persistence. Direct Knowledge calls to `observability.createCandidate()` are not allowed.

The existing `knowledge-summary.ts` parser logic should be reused/refactored rather than duplicated. The new submission subsystem becomes the owner of section ordering, aliases, limits, rendering, and validation.

## Persistent storage

Use the existing runtime `DATA_DIR` so operator edits survive image rebuilds and deployments:

```text
${DATA_DIR}/config/knowledge-submission-spec/
├── current.json
└── history/
    ├── v1.json
    ├── v2.json
    └── vN.json
```

The application also contains a built-in default spec used when no persisted spec exists. On first Admin save, the store persists the current/default version and the newly created version as needed so history remains complete.

Writes must be atomic. `current.json` always contains a complete valid spec. A failed write must leave the previous current spec active.

## Spec model

The persisted shape is versioned separately from the Knowledge rules:

```json
{
  "schema_version": 1,
  "spec_version": 1,
  "title": {
    "max_chars": 160,
    "recommended_min_chars": 20,
    "recommended_max_chars": 80
  },
  "content": {
    "max_chars": 50000,
    "format": "markdown"
  },
  "sections": [
    {
      "id": "problem",
      "heading": "问题",
      "required": true,
      "description": "描述需要解决的问题或观察到的现象"
    },
    {
      "id": "root_cause",
      "heading": "根因",
      "required": true,
      "description": "说明已验证的根本原因"
    },
    {
      "id": "solution",
      "heading": "解决方案",
      "required": true,
      "description": "说明最终有效的处理方案"
    },
    {
      "id": "verification",
      "heading": "验证结果",
      "required": true,
      "description": "记录测试、日志或其他验证证据"
    },
    {
      "id": "applicability",
      "heading": "适用范围",
      "required": true
    },
    {
      "id": "constraints",
      "heading": "约束/限制",
      "required": true
    }
  ],
  "requirements": {
    "durable": true,
    "verified": true,
    "reject_speculation": true,
    "reject_secrets": true,
    "reject_customer_sensitive_data": true
  }
}
```

`schema_version` describes the JSON representation understood by the server. `spec_version` is the monotonically increasing version of the Knowledge rules.

The first implementation supports Markdown only and keeps the existing six semantic section IDs. Admin may edit headings, descriptions, title/content limits, required flags, and requirement flags, but cannot create arbitrary new section IDs in v1 of this feature. This keeps the parser deterministic and avoids introducing a general-purpose schema DSL.

## MCP contract

Add:

```text
get_knowledge_submission_spec
```

Input:

```json
{
  "repository": "optional future selector"
}
```

The first version ignores repository-specific selection and returns the global current spec.

Output includes both machine-readable rules and model-ready text:

```json
{
  "spec_version": 4,
  "schema_version": 1,
  "rules": { "...": "current spec" },
  "template": "# Title\n\n## 问题\n...",
  "instruction": "Create durable, verified team Knowledge using the returned rules..."
}
```

Update `submit_knowledge_candidate` to accept required `spec_version` for MCP model submissions and raise its content limit to the current server contract maximum instead of retaining the stale 10,000-character limit.

Client guidance becomes stable process guidance only:

```text
When durable, verified team-specific knowledge should be submitted:
1. Call get_knowledge_submission_spec first.
2. Follow the returned current specification.
3. Submit with submit_knowledge_candidate using the returned spec_version.
4. Never submit secrets, credentials, customer-sensitive data, or unverified speculation.
```

The concrete six-section layout is removed from Codex/Claude guidance and setup scripts.

## Submission version behavior

A submission carries `spec_version` when it originates from MCP. The server still validates against the current spec.

Rules:

- If submitted content is valid under the current spec, accept it even if `submitted_spec_version < current_spec_version`.
- Record both the submitted spec version and the current spec version used for canonical validation.
- If content no longer satisfies the current spec, reject with a stable `KNOWLEDGE_SPEC_OUTDATED` error containing submitted and current versions and instruct the model to call `get_knowledge_submission_spec` again.
- Unknown/future submitted versions are rejected as invalid input.
- Admin and automatic server-side paths use the current spec directly and do not need to simulate an MCP fetch.

This avoids race failures for harmless spec edits while still forcing regeneration when the current contract has materially changed.

## Unified Knowledge Candidate path

All Knowledge Candidate creation must flow through one application-level method, conceptually:

```text
createKnowledgeCandidate(...)
  -> KnowledgeSubmissionService.normalizeAndValidate(...)
  -> observability.createCandidate(...)
```

This applies to:

- MCP `submit_knowledge_candidate`
- Admin manual Knowledge Candidate creation
- Gap-to-Knowledge Candidate creation
- automatic `codex-summary` candidates
- Curator-applied Knowledge content before save/publish

Legacy Skill Candidate compatibility remains separate and is not forced through the Knowledge contract.

Each Knowledge Candidate records:

```text
submissionSpecVersion
validationSpecVersion
submissionMode = mcp | admin | automatic | gap | curator
```

Existing persisted candidates without these fields remain readable.

## Automatic candidate behavior

Automatic candidates must stop persisting arbitrary excerpts directly as Knowledge.

The detector first constructs a structured Knowledge draft using the information it already has: title, problem, root cause, solution, verification evidence, applicability, and constraints. The Knowledge Submission Service renders and validates that draft using the current spec.

If required information is missing, the detector must not invent placeholder Knowledge such as `unknown`, `N/A`, or unsupported claims. Instead it records a skipped detection with a reason such as `missing-required-knowledge-field`.

Automatic Candidate creation remains human-reviewed and never publishes directly.

## Admin UI and API

Add a dedicated Admin page:

```text
/admin/knowledge-submission-spec
```

The page shows:

- current spec version and schema version
- title limits
- content limit
- section headings, descriptions, and required flags
- safety/quality requirement flags
- rendered Markdown template/instruction preview
- version history
- save as new version
- rollback to historical version

Saving never edits an existing version. It validates the submitted spec, increments `spec_version`, writes a new immutable history entry, and atomically updates current.

Rollback creates a new version containing the selected historical version's rules. Example: current v4 rollback to v2 content creates v5.

Admin API endpoints:

```text
GET  /admin/api/knowledge-submission-spec
PUT  /admin/api/knowledge-submission-spec
GET  /admin/api/knowledge-submission-spec/history
POST /admin/api/knowledge-submission-spec/rollback
```

Admin mutations use existing Admin authorization and should emit audit/event records without logging sensitive submission content.

## Error handling

Startup behavior:

- Missing persisted spec: use built-in default.
- Malformed `current.json`: fail closed at startup rather than silently reverting to defaults.
- Unsupported `schema_version`: fail closed with an explicit error.
- History corruption must not alter current; history reads report the invalid entry rather than activating it.

Runtime mutation behavior:

- Invalid Admin edits return validation errors and do not change current.
- Failed persistence leaves current unchanged.
- MCP fetch failure leaves the client without a submission spec; guidance must not tell the model to guess the old six-section format.
- MCP submission with outdated incompatible content returns `KNOWLEDGE_SPEC_OUTDATED` and the current version.

## Migration and compatibility

1. Built-in default spec v1 exactly represents the current six-section canonical format and current server limits: title max 160, summary max 50,000.
2. Existing Knowledge Candidate records remain readable without spec metadata.
3. Existing published Knowledge is not rewritten.
4. Client guidance is updated to fetch the spec dynamically; this requires a client integration release bump because installed guidance must change once.
5. After that release, future Knowledge rule edits do not require client integration upgrades.
6. `submit_knowledge_candidate` keeps its existing name and Knowledge-only semantics.
7. The stale MCP `content.max(10000)` limit is aligned with the server contract.

## Testing

Tests must cover at least:

- default spec loading when no persisted spec exists
- invalid current spec fails closed
- atomic version creation and immutable history
- rollback creates a new monotonic version
- current spec/template MCP response
- MCP submission with matching, older-compatible, older-incompatible, and future spec versions
- 50,000-character MCP contract alignment
- Admin save/history/rollback authorization and validation
- manual/Admin Knowledge uses the same normalizer
- automatic candidate uses the same normalizer
- automatic candidate skips rather than fabricates missing required sections
- Gap-created candidate uses the same normalizer
- Curator-edited Knowledge is revalidated before persistence/publication
- old Candidate records without spec metadata remain readable
- client guidance no longer embeds six-section headings and explicitly fetches the spec first
- full regression suite and build

## Documentation

Update developer documentation to describe the dynamic fetch flow instead of documenting a fixed six-section client contract. Document Admin configuration, version history, rollback semantics, MCP usage, and the fact that the server remains the final validator.

## Non-goals

The first implementation does not include:

- repository-specific or project-specific spec overrides
- arbitrary new section IDs or a general JSON-schema/DSL editor
- automatic migration or rewriting of already published Knowledge
- direct publication without human review
- client-side caching of the Knowledge submission spec
- moving Skill Bundle submission rules into this same subsystem

## Success criteria

The feature is complete when changing the current Knowledge submission rules through Admin immediately affects MCP guidance, MCP submission validation, Admin/manual candidates, automatic candidates, Gap-created candidates, and Curator-edited Knowledge without rebuilding the server image or upgrading Codex/Claude client integration; all of those paths share one server-side validation/normalization implementation.
