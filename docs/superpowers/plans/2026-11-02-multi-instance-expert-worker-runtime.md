# Multi-Instance Expert Worker Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support multiple independently managed Expert Worker instances on one host while sharing a single installed Worker Runtime.

**Architecture:** Keep `/opt/team-skill-hub-worker/current` host-scoped and make all runnable configuration and mutable state instance-scoped. `worker-control.sh` becomes the authoritative manual lifecycle/inventory CLI, systemd becomes a template unit, and Worker config parsing derives instance-local defaults from `EXPERT_WORKER_INSTANCE` without changing Hub scheduling semantics.

**Tech Stack:** Bash, Node.js 24 / TypeScript, node:test, systemd, Docker.

**Spec:** `docs/superpowers/specs/2026-11-02-multi-instance-expert-worker-runtime-design.md`

## Global Constraints

- Runnable configs live only at `/etc/team-skill-hub-worker/workers/<instance>.env`.
- `/etc/team-skill-hub-worker/worker.env.example` is a template only.
- Legacy `/etc/team-skill-hub-worker/worker.env` is never consumed by the new runtime.
- Instance names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
- Instance mutable state lives under `/var/lib/team-skill-hub-worker/<instance>/`.
- Instance secrets live under `/etc/team-skill-hub-worker/instances/<instance>/keys/`.
- Host-local instance name and Hub `EXPERT_WORKER_ID` remain separate.
- No inventory/status output may expose secret values.
- Multiple Workers must never share the same repository checkout.
- Runtime installation must not silently restart Worker instances.

## Review Focus

- A malformed `workers/*.env` file must not make `worker-control.sh list` fail for valid instances; Task 2 adds mixed valid/invalid inventory tests.
- A stale PID file must never let one instance signal another Worker process; Task 2 adds cross-instance/stale PID tests.
- Legacy `/etc/team-skill-hub-worker/worker.env` must not be sourced accidentally by installer/controller/systemd; Tasks 2 and 3 pin this.
- `list --json` must remain valid JSON even when instances are stopped/invalid and must contain no token/key values; Task 2 pins this.
- systemd must isolate writable state to the selected instance rather than widening access to all Worker state; Task 3 verifies the template/wrapper contract.

---

### Task 1: Instance-aware Worker runtime defaults

**Files:**
- Modify: `src/cli/expert-worker.ts`
- Modify: `src/expert-platform/worker-runtime-config.ts`
- Modify: `worker-runtime/check-worker-config.js`
- Test: `tests/expert-platform-worker-runtime-config.test.ts`
- Test: `tests/expert-platform-worker-install-scripts.test.ts`

**Interfaces:**
- Consumes: `EXPERT_WORKER_INSTANCE`, optional explicit `EXPERT_WORKER_CREDENTIAL_FILE`, `EXPERT_SOURCE_PATH`, `EXPERT_REPOSITORY_ROOT`.
- Produces: instance-local defaults rooted at `/var/lib/team-skill-hub-worker/<instance>`; explicit path env values continue to override defaults.

- [ ] **Step 1: Add failing config tests for instance-derived defaults**

Add tests asserting that with:

```text
EXPERT_WORKER_INSTANCE=claude-01
EXPERT_WORKER_ID=ota-claude-worker-01
```

and no explicit source/repository paths, config resolves under:

```text
/var/lib/team-skill-hub-worker/claude-01/source
/var/lib/team-skill-hub-worker/claude-01/repositories/<worker-id>
```

Also assert invalid instance names fail with `INVALID_WORKER_CONFIG`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --import tsx --test tests/expert-platform-worker-runtime-config.test.ts tests/expert-platform-worker-install-scripts.test.ts
```

Expected: new instance-default assertions fail.

- [ ] **Step 3: Implement a shared TypeScript instance-root rule**

In `src/expert-platform/worker-runtime-config.ts`, add a small exported helper:

```ts
export function workerInstanceDataRoot(env: NodeJS.ProcessEnv): string | undefined
```

It validates `EXPERT_WORKER_INSTANCE` against the spec regex and returns:

```text
/var/lib/team-skill-hub-worker/<instance>
```

when present.

Use it to derive default `sourcePath` and `repositoryRootBase` only when explicit env paths are absent.

- [ ] **Step 4: Make credential bootstrap instance-aware**

In `src/cli/expert-worker.ts`, derive the default credential file as:

```text
<instanceDataRoot>/worker-credential
```

when `EXPERT_WORKER_CREDENTIAL_FILE` is absent.

Keep explicit override behavior unchanged.

- [ ] **Step 5: Update packaged config validation**

Update `worker-runtime/check-worker-config.js` to require/validate `EXPERT_WORKER_INSTANCE`, derive the same instance-local credential/repository/source defaults, and stop requiring an explicit `EXPERT_REPOSITORY_ROOT` when a valid instance supplies the default.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the focused command from Step 2.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/expert-worker.ts src/expert-platform/worker-runtime-config.ts worker-runtime/check-worker-config.js tests/expert-platform-worker-runtime-config.test.ts tests/expert-platform-worker-install-scripts.test.ts
git commit -m "feat(worker): add instance-local runtime defaults"
```

---

### Task 2: Multi-instance manual controller, init, list, and JSON inventory

**Files:**
- Modify: `worker-runtime/worker-control.sh`
- Modify: `worker-runtime/worker.env.example`
- Test: `tests/expert-platform-worker-install-scripts.test.ts`
- Create: `tests/fixtures/worker-runtime/` only if fixture env files materially simplify subprocess tests.

**Interfaces:**
- Produces CLI:
  - `worker-control.sh init <instance>`
  - `worker-control.sh list [--json]`
  - `worker-control.sh <instance> start|stop|restart|status|logs`
- Uses:
  - config: `/etc/team-skill-hub-worker/workers/<instance>.env`
  - data: `/var/lib/team-skill-hub-worker/<instance>`
  - keys: `/etc/team-skill-hub-worker/instances/<instance>/keys`

- [ ] **Step 1: Add RED tests for command grammar and instance validation**

Assert the script contains/accepts the new host-level and instance-level forms and rejects:

```text
../bad
a/b
""
space name
```

without constructing paths outside the Worker roots.

Use test-only environment overrides for root directories so subprocess tests do not need real `/etc` or `/var/lib`.

- [ ] **Step 2: Add RED tests for `init`**

In a temporary root, assert:

```bash
worker-control.sh init claude-01
```

creates:

```text
etc/team-skill-hub-worker/workers/claude-01.env
etc/team-skill-hub-worker/instances/claude-01/keys/
var/lib/team-skill-hub-worker/claude-01/
```

with the env copied from the example, and refuses a second init.

- [ ] **Step 3: Add RED inventory tests**

Create two valid instance configs and one invalid config. Assert human `list`:

- sorts by instance name
- shows instance, worker ID, backend, capability, profiles, status, PID
- reports the malformed instance as `invalid-config`
- still returns the valid instances.

Add `list --json` assertions for valid JSON and exact status values.

Seed token/key-looking values into env files and assert neither output contains them.

- [ ] **Step 4: Add RED PID isolation tests**

Create per-instance PID/start files and fake process metadata through a test seam or helper override.

Assert:

- stale PID => `stale-pid`
- instance A cannot use instance B's PID state
- matching systemd detection is instance-specific.

- [ ] **Step 5: Run controller tests and verify RED**

Run:

```bash
node --import tsx --test tests/expert-platform-worker-install-scripts.test.ts
```

Expected: new multi-instance tests fail.

- [ ] **Step 6: Refactor `worker-control.sh` around an instance context**

Add functions with these contracts:

```bash
validate_instance <name>
load_instance_context <name>
init_instance <name>
list_instances <human|json>
start_worker <name>
stop_worker <name>
status_worker <name>
logs_worker <name>
```

Permit test-only root overrides such as:

```text
WORKER_RUNTIME_ETC_ROOT
WORKER_RUNTIME_DATA_ROOT
WORKER_RUNTIME_BASE
```

but default production behavior to the spec paths.

Do not source legacy `/etc/team-skill-hub-worker/worker.env`.

- [ ] **Step 7: Implement safe inventory**

For each `workers/*.env`:

- validate file ownership/mode when running against production roots
- load only that instance config
- derive backend/capability/profiles/worker ID
- evaluate its PID/start state
- emit one independent result row.

`list --json` writes only JSON to stdout.

- [ ] **Step 8: Update `worker.env.example`**

Remove hard-coded single-instance credential/source/repository defaults.

Document that `EXPERT_WORKER_INSTANCE` is launcher-provided and instance-local defaults are derived automatically.

Keep optional override examples.

- [ ] **Step 9: Run controller tests and verify GREEN**

Run the focused test from Step 5 plus:

```bash
bash -n worker-runtime/worker-control.sh
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add worker-runtime/worker-control.sh worker-runtime/worker.env.example tests/expert-platform-worker-install-scripts.test.ts tests/fixtures/worker-runtime
git commit -m "feat(worker): add multi-instance lifecycle control"
```

---

### Task 3: Host-scoped installer and systemd template

**Files:**
- Modify: `worker-runtime/install-worker.sh`
- Rename/Create: `worker-runtime/team-skill-hub-worker@.service`
- Remove from package: `worker-runtime/team-skill-hub-worker.service`
- Modify: `scripts/package-worker-runtime.mjs`
- Test: `tests/expert-platform-worker-install-scripts.test.ts`

**Interfaces:**
- Installer installs one Runtime and no runnable Worker instance.
- systemd entrypoint: `team-skill-hub-worker@<instance>.service`.
- Template reads `/etc/team-skill-hub-worker/workers/%i.env` and injects `EXPERT_WORKER_INSTANCE=%i`.

- [ ] **Step 1: Add RED package/installer tests**

Assert:

- archive contains `team-skill-hub-worker@.service`
- archive no longer depends on fixed `team-skill-hub-worker.service`
- installer creates shared `workers/`, `instances/`, data root, and installs `worker.env.example`
- installer does not create `workers/default.env` or runnable `worker.env`
- installer prints a migration warning when legacy `worker.env` exists.

- [ ] **Step 2: Add RED systemd template tests**

Assert template contains:

```ini
Environment=EXPERT_WORKER_INSTANCE=%i
EnvironmentFile=/etc/team-skill-hub-worker/workers/%i.env
```

and uses the shared Runtime.

Pin instance-specific writable-path behavior either directly with `ReadWritePaths=/var/lib/team-skill-hub-worker/%i` after actual systemd verification, or through a validated launcher wrapper if specifier expansion proves unsuitable.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --import tsx --test tests/expert-platform-worker-install-scripts.test.ts
```

Expected: template/installer assertions fail.

- [ ] **Step 4: Make installer host-scoped**

Refactor `install-worker.sh` so it:

- installs/upgrades shared Runtime
- installs template/example
- creates shared roots only
- never creates a Worker instance
- never restarts all instances
- reports the new `worker-control.sh init <instance>` next step.

- [ ] **Step 5: Implement systemd template**

Create `worker-runtime/team-skill-hub-worker@.service`.

Use the shared Runtime and instance config. Preserve current security controls: unprivileged user, `NoNewPrivileges`, `PrivateTmp`, strict filesystem protection, and instance-local writable state.

- [ ] **Step 6: Update runtime packaging**

Change `scripts/package-worker-runtime.mjs` to package the template unit instead of the fixed unit.

- [ ] **Step 7: Verify Bash, package, and focused tests**

Run:

```bash
bash -n worker-runtime/install-worker.sh
bash -n worker-runtime/worker-control.sh
node --import tsx --test tests/expert-platform-worker-install-scripts.test.ts
npm run build:worker-runtime
```

Expected: all PASS and archive contains the template service.

- [ ] **Step 8: Commit**

```bash
git add worker-runtime/install-worker.sh worker-runtime/team-skill-hub-worker@.service worker-runtime/team-skill-hub-worker.service scripts/package-worker-runtime.mjs tests/expert-platform-worker-install-scripts.test.ts
git commit -m "feat(worker): install shared runtime with systemd instances"
```

---

### Task 4: Documentation and migration instructions

**Files:**
- Modify: `worker-runtime/README.md`
- Modify: relevant `docs/expert-platform/*.md`
- Modify: `docs/superpowers/specs/2026-11-02-multi-instance-expert-worker-runtime-design.md` only if implementation discovers a necessary design correction.

**Interfaces:**
- Documents the exact install/init/list/start flow.
- Documents that old `/etc/team-skill-hub-worker/worker.env` is unsupported and requires reviewed migration.

- [ ] **Step 1: Update standalone runtime README**

Document:

```text
install Runtime once
worker-control.sh init <instance>
edit workers/<instance>.env
worker-control.sh list
worker-control.sh <instance> start
```

Include both systemd and manual examples for two simultaneous instances.

- [ ] **Step 2: Update Expert Platform deployment documentation**

Document host/instance/Worker ID distinctions, per-instance keys and repositories, and recommended one-instance-per-profile model.

- [ ] **Step 3: Add migration section**

Explicitly state:

- old `worker.env` is not read
- no automatic secret/repository migration occurs
- administrator chooses a new instance name and copies reviewed settings only.

- [ ] **Step 4: Verify documentation references**

Run:

```bash
grep -R "/etc/team-skill-hub-worker/worker.env" -n worker-runtime docs/expert-platform
```

Expected: remaining references are only migration/history statements, not runnable instructions.

- [ ] **Step 5: Commit**

```bash
git add worker-runtime/README.md docs/expert-platform docs/superpowers/specs/2026-11-02-multi-instance-expert-worker-runtime-design.md
git commit -m "docs(worker): document multi-instance deployment"
```

---

### Task 5: Full verification and real two-Worker acceptance

**Files:**
- No product changes expected unless verification finds a defect.
- Add/update tests only for defects found during acceptance.

**Interfaces:**
- Acceptance host has one shared Runtime and at least two Worker instances.
- Recommended real pair: one Claude Worker and one Codex Worker.

- [ ] **Step 1: Run the full repository gate**

Run:

```bash
npm run check
git diff --check
```

Expected: PASS.

- [ ] **Step 2: Build a fresh Worker Runtime package**

Run:

```bash
npm run build:worker-runtime
```

Install the generated package into the WSL2 validation host using the new installer.

- [ ] **Step 3: Initialize two real Worker instances**

For example:

```bash
worker-control.sh init claude-01
worker-control.sh init codex-01
```

Configure distinct:

- `EXPERT_WORKER_ID`
- backend/runtime profile
- credential file
- repository root
- model/MCP credential mappings.

- [ ] **Step 4: Verify inventory**

Run:

```bash
worker-control.sh list
worker-control.sh list --json
```

Expected: both instances visible independently, no secrets in either output.

- [ ] **Step 5: Start both Workers concurrently**

Start both via the same control mode being validated (manual on WSL2 unless systemd is enabled).

Verify:

- both remain registered
- separate PID/log/data paths
- stopping one does not stop the other.

- [ ] **Step 6: Dispatch one real task to each backend**

Use Team Skill Hub Expert Platform to dispatch one read-only task through a Claude Deployment and one through a Codex Deployment.

Expected: both reach `succeeded`, and runtime records show the intended backend/Worker.

- [ ] **Step 7: Final review**

Review the complete branch for:

- path traversal or instance-name injection
- credential leakage in inventory
- cross-instance PID/repository interference
- systemd/manual conflicts
- legacy config accidental consumption.

- [ ] **Step 8: Final verification commit if needed**

If acceptance required fixes, commit those fixes separately after focused regression tests. Otherwise leave the prior task commits unchanged.
