# Evaluation and Candidate Design

Canonical design for deterministic evaluation, retrieval regression checks, and automatic Knowledge Candidate policy.


## Evaluation Framework

### Goal

The Evaluation Framework protects Git-managed Skills, Prompts, and Agents from regression without adding a model gateway, external database, or LLM-as-judge dependency.

For a ~30-person engineering team, the first evaluation layer should be deterministic, cheap, reviewable, and stable in CI.

### Golden suite location

A repository may contain one or more files named:

```text
EVALUATION.yaml
```

Example layout:

```text
rd-skills/
└── ota/
    ├── EVALUATION.yaml
    ├── AGENT.yaml
    └── code-review/
        ├── SKILL.md
        └── PROMPT.md
```

The suite is versioned in GitLab with the assets it evaluates.

### Schema

```yaml
schema_version: 1
id: ota-core-regression
description: Deterministic OTA regression suite.

cases:
  - id: resolve-review-skill
    target: skill
    operation: resolve
    query: review OTA implementation for unnecessary APIs
    client: codex
    expect:
      selected: ota-code-review

  - id: prompt-contract
    target: prompt
    operation: get
    name: ota-code-review-prompt
    expect:
      contains:
        - estimate deletion/change risk

  - id: agent-bindings
    target: agent
    operation: get
    name: ota-expert
    expect:
      skills:
        - ota-code-review
      prompts:
        - ota-code-review-prompt
      tools:
        - git
```

### Targets and operations

Supported targets:

```text
skill
prompt
agent
```

Supported operations:

```text
search
resolve
get
```

`search` and `resolve` require `query`. `get` requires `name`.

### Expectations

#### Routing expectation

```yaml
expect:
  selected: ota-code-review
  repository: rd-skills
```

#### Content contract

```yaml
expect:
  contains:
    - deletion risk
    - smallest safe change
```

#### Agent binding contract

```yaml
expect:
  skills:
    - ota-code-review
  prompts:
    - ota-code-review-prompt
  tools:
    - git
    - repository-read
```

### Local/CI CLI

Run all suites:

```bash
npm run evaluate:repo -- \
  --path ../rd-skills \
  --id rd-skills \
  --revision working-tree
```

Run one suite:

```bash
npm run evaluate:repo -- \
  --path ../rd-skills \
  --id rd-skills \
  --suite ota-core-regression
```

Compare candidate with baseline:

```bash
npm run evaluate:repo -- \
  --path ../rd-skills \
  --baseline-path /tmp/skill-baseline \
  --id rd-skills \
  --revision candidate \
  --baseline-revision main
```

The process exits with code `1` when:

- any candidate golden case fails;
- candidate passed-case count falls below baseline;
- a previously passing baseline case is removed;
- a baseline suite is removed from the candidate.

This prevents a regression from being hidden simply by deleting tests.

### GitLab merge-request workflow

The supplied `examples/ci/gitlab-ci-skill-validation.yml` performs:

```text
validate repository
        |
        v
find EVALUATION.yaml
        |
        v
checkout MR target branch as baseline
        |
        v
run baseline suites
        |
        v
run candidate suites
        |
        v
compare
        |
        +-- pass -> MR can continue
        |
        `-- fail/regression -> CI fails
```

Repositories with no evaluation suite can still use the generic validator; deterministic evaluation is skipped until a suite is added.

### Runtime evaluation against validated revisions

The Hub can evaluate any retained validated revision.

MCP tools:

```text
list_evaluation_suites
run_evaluation
list_evaluation_runs
get_evaluation_run
```

Example conceptual request:

```text
run_evaluation
repository = rd-skills
suite = ota-core-regression
revision = <candidate revision>
baseline_revision = <previous revision>
```

The result includes total/passed/failed/pass-rate, per-case evidence, baseline statistics, removed baseline cases, and the regression flag.

### Admin HTTP APIs

```text
GET  /repositories/<id>/evaluations/suites?revision=<revision>
POST /repositories/<id>/evaluations/run
GET  /evaluations/runs
GET  /evaluations/runs/<run-id>
```

Run body:

```json
{
  "suite": "ota-core-regression",
  "revision": "<candidate>",
  "baseline_revision": "<baseline>"
}
```

These endpoints require the existing admin key.

### Persistence

Runtime evaluation runs are stored under:

```text
<data_dir>/evaluations/runs.jsonl
```

The store is bounded to recent runs and is derived operational data, not source of truth. Golden suites remain Git-owned.

### Snapshot semantics

A repository revision is considered validated only after all of the following parse/validation stages succeed:

```text
Skill validation
Prompt validation
Agent validation/bindings
Evaluation-suite syntax validation
        |
        v
create immutable snapshot
```

A malformed `EVALUATION.yaml` therefore cannot create a new validated revision. Rollback also rechecks evaluation-suite syntax before activation.

### What this framework intentionally does not evaluate

The V1 framework does not call a language model and therefore does not score subjective answer quality, factual correctness of generated prose, or style.

Those can later be layered on using human feedback or a separate judge adapter if the team has enough real datasets to justify it. The deterministic layer should remain even if model-based evaluation is added later.

### Recommended initial dataset size

Start with roughly 10–30 high-value cases for each important domain/Agent, taken from real historical work. Prefer cases that protect routing decisions, mandatory review constraints, safety/process requirements, and critical Agent bindings. Expand from production unmatched queries and actual regressions rather than creating hundreds of synthetic tests up front.


## Retrieval Evaluation Guide

### Purpose

Retrieval changes must be proven by deterministic Evaluation rather than subjective inspection. This applies to ranking boosts, lifecycle filtering, applicability rules, chunking, and any future hybrid retrieval.

### Metrics

Knowledge retrieval cases report:

- Hit@1
- Hit@3
- Hit@5
- MRR

Evaluation also records total/pass/fail and baseline regression.

### Repository suites

Put `EVALUATION.yaml` beside the assets it protects. Knowledge cases use target `knowledge` with search/get expectations. Skill/Prompt/Agent cases can live in the same suite.

### Local run

~~~bash
npm run evaluate:repo -- \
  --path ../rd-skills \
  --id rd-skills \
  --revision working-tree
~~~

With a baseline:

~~~bash
npm run evaluate:repo -- \
  --path ../rd-skills \
  --id rd-skills \
  --revision candidate \
  --baseline-path ../rd-skills-baseline \
  --baseline-revision baseline
~~~

### CI gate

`npm run ci:evaluate` is an alias intended for CI. It exits non-zero for hard gate failure, including failed cases, regression, or removed baseline suites.

Thresholds can be configured:

~~~bash
npm run ci:evaluate -- \
  --path ../rd-skills \
  --min-pass-rate 1 \
  --min-hit-at-1 0.8 \
  --min-hit-at-3 0.95 \
  --min-hit-at-5 1 \
  --min-mrr 0.85
~~~

Warning thresholds are available separately with `--warn-*` arguments.

### Admin Web

Evaluation tab can:

- load suites from an active revision;
- choose candidate and baseline revisions;
- run a suite;
- show failed cases;
- show Hit@1/3/5 and MRR;
- display historical runs and regression state.

### Change policy

For ranking/chunking changes:

1. add or update golden cases first;
2. run the current implementation as baseline;
3. make one deterministic ranking/chunking change;
4. compare candidate vs baseline;
5. keep the change only when the Evaluation result supports it.

Do not introduce embedding/vector infrastructure solely because an anecdotal query looks weak.


## Automatic Knowledge Candidate Policy

### Principle

Automatic generation reduces developer friction, but only Human Review can promote a Candidate toward Git-managed Knowledge.

### Defaul

Automatic Knowledge is enabled by default by the setup scripts.

Opt out:

~~~bash
bash scripts/setup-codex-mcp.sh --no-auto-knowledge
~~~

~~~powershell
.\scripts\setup-codex-mcp.ps1 -NoAutoKnowledge
~~~

The preference is preserved by setup upgrade unless explicitly changed.

### Detector

Current detector:

~~~tex
stop-evidence-v2
~~~

It classifies reusable results as:

- root-cause;
- verified-fix;
- workaround;
- reusable-constraint.

### Required signals

A Stop event is eligible only when the session shows a useful combination of:

- engineering action;
- structured passing Evidence;
- a sufficiently informative final result;
- reusable engineering content.

### Skip rules

The detector records a reason when it skips generation. Important reasons include:

- no engineering action;
- no strong test Evidence;
- final summary too short;
- low-reuse-value summary;
- exact/near/template duplicate;
- Candidate already generated;
- session/user rate limit;
- Stop-hook recursion.

### Duplicate and relation handling

Candidate dedupe has two layers:

- exact fingerprint -> `duplicateOf`;
- deterministic near duplicate -> `possibleDuplicateOf` + similarity.

High-confidence near duplicates generated automatically are skipped. Manually submitted similar Candidates remain reviewable and receive a warning.

The detector may suggest `updates`, `supersedes`, `conflicts_with`, or `related_to`. A Reviewer must confirm the final relation.

### Safety boundary

Automatic Candidates:

- remain `pending`;
- never auto-approve;
- never auto-merge;
- never bypass GitLab MR review;
- retain Evidence and detector reasoning for audit.
