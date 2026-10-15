# Team Skill Hub Client Integration Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a self-hosted, versioned Team Skill Hub client integration that detects updates at Claude/Codex SessionStart, upgrades only after explicit user approval, survives interruption, preserves custom client homes, and rolls back safely.

**Architecture:** Add a single `client-integration/release.json` version source, build versioned Linux/Windows client packages into the server image, and expose them as static release resources. A small local launcher owns state/cache/locks/transactions and delegates managed configuration changes to versioned updater logic; Codex and Claude share update decisions but keep client-specific SessionStart renderers.

**Tech Stack:** Node.js 24 + TypeScript 5.9, Node built-in test runner, Bash, PowerShell, Fastify, Docker.

**Spec:** `docs/superpowers/specs/2026-10-15-client-integration-update-design.md`

## Global Constraints

- Team Skill Hub runs in a trusted intranet; SHA-256 detects corruption/build mismatch, not a malicious publisher.
- No background or silent upgrade; `session-start` may check only, and `upgrade` runs only after explicit user intent.
- SessionStart cache-hit target is `< 50 ms`; network manifest check budget defaults to `<= 800 ms`; SessionStart never downloads or applies packages.
- Manifest/package endpoints are read-only release resources and require no API key in phase 1.
- Package paths are relative to the manifest URL and resolved with standard URL resolution so reverse-proxy path prefixes are preserved.
- Client state never stores API key/token values; only the environment-variable name is persisted.
- `CODEX_HOME` / `CLAUDE_CONFIG_DIR` are resolved during bootstrap and persisted as absolute `config_home` paths; later upgrades never infer them again from the current environment.
- Codex and Claude must point to one Hub base URL in phase 1; bootstrap fails clearly instead of silently merging different Hub targets.
- Upgrade/rollback share one exclusive mutation lock; update-check uses a non-blocking lock and must fail open.
- Client keeps at least current + previous successful release locally; rollback must not depend on the server still hosting the previous package.
- MCP API correctness remains server-owned; client guidance cannot be the only enforcement mechanism for breaking API changes.

## Review Focus

- Corrupt/truncated `state.json` or manifest: fail open for SessionStart, but fail closed with a diagnostic for mutation commands; never overwrite a recoverable prior state blindly.
- Stale lock after process death: locks must include enough ownership/liveness information to recover safely instead of permanently blocking upgrades.
- Crash after managed files are changed but before `current`/`state.json` commit: next launcher invocation restores the previous committed state from the journal.
- Existing Claude/Codex config contains malformed JSON/TOML or duplicate legacy Team Skill Hub blocks: updater must not destroy unrelated configuration and must surface a precise error.
- Reverse proxy URL such as `https://host/skill-hub/mcp`: manifest/package resolution must stay under `/skill-hub/`, never jump to host root.

---

### Task 1: Establish the single release metadata source and build-time manifest model

**Files:**
- Create: `client-integration/release.json`
- Create: `src/client-integration/release.ts`
- Create: `tests/client-integration-release.test.ts`

**Interfaces:**
- Produces: `ClientIntegrationRelease` type; `loadClientIntegrationRelease(root?: string): Promise<ClientIntegrationRelease>`; `buildClientIntegrationManifest(release, options): ClientIntegrationManifest`.

- [ ] **Step 1: Write failing metadata tests**

Add tests named `loads canonical client integration release metadata`, `rejects invalid version ordering`, and `renders relative package paths`. Assert the initial metadata has `schemaVersion: 1`, positive integer `version`, `minimumSupportedVersion <= version`, and manifest paths exactly `releases/<version>/linux.tar.gz` / `releases/<version>/windows.zip`.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --import tsx --test tests/client-integration-release.test.ts`

Expected: FAIL because `src/client-integration/release.ts` / `client-integration/release.json` do not exist.

- [ ] **Step 3: Implement canonical release parsing and manifest construction**

Create `src/client-integration/release.ts` with the exact exported interfaces and functions above. Validate integer versions, `minimumSupportedVersion <= version`, non-empty hook runtime version, and positive hook schema version. Do not duplicate the primary client integration version in setup scripts or server source.

- [ ] **Step 4: Add initial release metadata**

Create `client-integration/release.json` with schema/version/minimum/hook fields matching the first implementation release.

- [ ] **Step 5: Run focused tests**

Run: `node --import tsx --test tests/client-integration-release.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client-integration/release.json src/client-integration/release.ts tests/client-integration-release.test.ts
git commit -m "feat: add client integration release metadata"
```

### Task 2: Build deterministic Linux and Windows client integration packages

**Files:**
- Create: `src/cli/build-client-integration.ts`
- Create: `client-integration/templates/` package source tree for launcher/runtime/updater assets
- Create: `tests/client-integration-build.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `loadClientIntegrationRelease()` and `buildClientIntegrationManifest()` from Task 1.
- Produces: `dist/client-integration/manifest.json`, `dist/client-integration/releases/<version>/linux.tar.gz`, `windows.zip`, and `checksums.json`.

- [ ] **Step 1: Write failing package-build tests**

Create tests that run the build CLI in a temporary output directory and assert: both platform archives exist; `manifest.json` versions match `release.json`; relative package paths resolve under the manifest directory; SHA-256 entries equal recomputed archive hashes; required launcher/runtime/updater files are present; a file matching secret-like fixture names is rejected.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --import tsx --test tests/client-integration-build.test.ts`

Expected: FAIL because the builder does not exist.

- [ ] **Step 3: Add the archive build dependency**

Add `tar` as a dev dependency for deterministic `linux.tar.gz` generation; keep the existing `jszip` dependency for `windows.zip`. Commit the resulting `package-lock.json` update with this task.

- [ ] **Step 4: Implement the build CLI**

Implement `src/cli/build-client-integration.ts` to collect only an explicit allow-list of setup/hooks/guidance/runtime assets, generate Linux `tar.gz` with `tar` and Windows ZIP with `jszip`, calculate SHA-256, and emit the manifest/checksum metadata. Do not scan arbitrary repository files into the package.

- [ ] **Step 5: Wire `npm run build:client-integration`**

Set the package script to `tsx src/cli/build-client-integration.ts` and make the CLI default output `dist/client-integration`.

- [ ] **Step 6: Run focused tests and a real build**

Run:

```bash
node --import tsx --test tests/client-integration-build.test.ts
npm run build:client-integration
```

Expected: tests PASS and `dist/client-integration/manifest.json` plus both archives exist.

- [ ] **Step 7: Commit**

```bash
git add src/cli/build-client-integration.ts client-integration/templates tests/client-integration-build.test.ts package.json package-lock.json
git commit -m "feat: build versioned client integration packages"
```

### Task 3: Implement local state, cache, locks, URL resolution, and transaction recovery primitives

**Files:**
- Create: `client-integration/runtime/client-runtime.mjs`
- Create: `tests/client-integration-runtime.test.ts`

**Interfaces:**
- Produces: runtime commands `version`, `check-update`, `session-start`, `upgrade`, `rollback`, `doctor`.
- Internal exported/testable functions: `readState()`, `writeStateAtomic()`, `resolvePackageUrl()`, `readManifestCache()`, `acquireUpdateCheckLock()`, `acquireMutationLock()`, `recoverIncompleteTransaction()`.

- [ ] **Step 1: Write failing runtime primitive tests**

Add tests for: state round-trip without secrets; malformed state behavior; manifest path resolution from `https://host/skill-hub/client-integration/manifest.json`; 12-hour TTL; non-blocking update-check lock; exclusive mutation lock; stale lock recovery; atomic state replacement; recovery of journals stopped in `applying` and `applied`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --import tsx --test tests/client-integration-runtime.test.ts`

Expected: FAIL because runtime primitives do not exist.

- [ ] **Step 3: Implement the state/cache/URL primitives**

Use `~/.team-skill-hub` (overridable by a test-only root environment variable) with `state.json`, `cache/manifest.json`, `locks/`, `transactions/`, `releases/`, and a current pointer. `writeStateAtomic()` must write temp + rename. `resolvePackageUrl()` must use `new URL(relativePath, manifestUrl)`.

- [ ] **Step 4: Implement lock ownership and stale recovery**

Mutation lock must carry PID + creation timestamp + command. Reclaim only when the recorded process is no longer alive or the lock is structurally invalid under an explicit conservative rule. Update-check lock is non-blocking: failure to acquire returns cached/no-update decision immediately.

- [ ] **Step 5: Implement transaction journal recovery**

Define journal states `prepared`, `applying`, `applied`, `committed`; include from/to version, previous current pointer/state snapshot, managed backup directory, and target clients. Every launcher command begins with `recoverIncompleteTransaction()` before performing normal work.

- [ ] **Step 6: Run focused tests**

Run: `node --import tsx --test tests/client-integration-runtime.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client-integration/runtime/client-runtime.mjs tests/client-integration-runtime.test.ts
git commit -m "feat: add client runtime state and recovery primitives"
```

### Task 4: Implement update decisions and client-specific SessionStart rendering

**Files:**
- Modify: `client-integration/runtime/client-runtime.mjs`
- Create: `client-integration/runtime/render-codex.mjs`
- Create: `client-integration/runtime/render-claude.mjs`
- Create: `tests/client-integration-session-start.test.ts`

**Interfaces:**
- Consumes: Task 3 state/cache/lock primitives.
- Produces: `decideUpdate(installedVersion, manifest): "none" | "optional_update" | "required_update"`; bounded `session-start --client codex|claude` behavior.

- [ ] **Step 1: Write failing decision/budget tests**

Cover: installed==latest => no output; minimum<=installed<latest => optional; installed<minimum => required; valid cache avoids fetch; expired cache performs one fetch; concurrent refresh uses stale cache/fail-open; network timeout returns within configured budget; oversized/invalid manifest fails open; SessionStart never creates a package download file.

- [ ] **Step 2: Add renderer contract tests**

Pin Codex and Claude renderers separately so `session-start` returns the shared structured decision to a renderer rather than emitting arbitrary shared stdout. Add fixture tests for the exact hook output shape accepted by each client after verifying the real CLI contracts during implementation.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `node --import tsx --test tests/client-integration-session-start.test.ts`

Expected: FAIL because decision/rendering logic is missing.

- [ ] **Step 4: Implement bounded manifest checking**

Use the 12-hour cache, short fetch timeout, and an overall default budget of 800 ms. Add a bounded manifest response size and ensure all network/parse failures return a fail-open decision for SessionStart.

- [ ] **Step 5: Implement client-specific renderers**

Keep decision logic client-neutral. Codex/Claude adapters map `optional_update` and `required_update` into the verified SessionStart hook output contract; `none` emits no notice.

- [ ] **Step 6: Run focused tests**

Run: `node --import tsx --test tests/client-integration-session-start.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client-integration/runtime tests/client-integration-session-start.test.ts
git commit -m "feat: add bounded session start update checks"
```

### Task 5: Implement versioned updater apply, upgrade transaction, and rollback reconciliation

**Files:**
- Create: `client-integration/updater/updater.mjs`
- Modify: `client-integration/runtime/client-runtime.mjs`
- Create: `tests/client-integration-updater.test.ts`

**Interfaces:**
- Consumes: Task 3 transaction/lock/state primitives and Task 1/2 package metadata.
- Produces: `applyManagedConfig(context)`, `selfCheckManagedConfig(context)`, `reconcileToVersion(context)`, and complete `upgrade` / `rollback` commands.

- [ ] **Step 1: Write failing updater integration tests**

Use temporary homes and assert: v4->v5 updates only Team Skill Hub managed blocks; unrelated JSON/TOML/Markdown remains byte-equivalent where untouched; repeated apply is idempotent; custom Codex/Claude `config_home` paths are honored; malformed config aborts without partial mutation; SHA mismatch never runs updater; mutation lock rejects a second upgrade.

- [ ] **Step 2: Add crash-point recovery tests**

Inject failures after managed backup, after first managed-file write, after updater self-check, after current switch, and before state commit. After a simulated next launcher invocation, assert the machine returns to the previous committed version/config.

- [ ] **Step 3: Add rollback tests**

Assert current + previous are retained locally; rollback uses target-version reconciliation/migration semantics; rollback succeeds with the server unavailable; rollback and upgrade contend on the same mutation lock.

- [ ] **Step 4: Run focused tests and verify failure**

Run: `node --import tsx --test tests/client-integration-updater.test.ts`

Expected: FAIL because updater/mutation flow is missing.

- [ ] **Step 5: Implement managed configuration adapters**

Port existing setup behavior into updater helpers for Claude MCP permission/registration, Claude managed `CLAUDE.md`, Claude hooks, Codex MCP block, Codex managed `AGENTS.md`, Codex hooks, and hook config. Preserve non-Team-Skill-Hub content and use temp + rename for each managed file.

- [ ] **Step 6: Implement the full upgrade transaction**

Under the mutation lock: fetch manifest; download to temp; verify SHA-256; unpack to `releases/vN.tmp`; verify package metadata; create journal + backups; apply; self-check; rename release; switch current; update state with `previous_version`; mark committed; cleanup. Never switch current before apply + self-check succeed.

- [ ] **Step 7: Implement rollback reconciliation**

Use the locally retained previous release updater to reconcile managed state to the target version, then switch current/state transactionally. Do not model rollback as simply rerunning the old `apply` without explicit target-version reconciliation.

- [ ] **Step 8: Run focused tests**

Run: `node --import tsx --test tests/client-integration-updater.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add client-integration/runtime client-integration/updater tests/client-integration-updater.test.ts
git commit -m "feat: add transactional client integration upgrades"
```

### Task 6: Serve release artifacts and expose client integration diagnostics

**Files:**
- Modify: `src/server.ts`
- Modify: `src/mcp.ts`
- Modify: `Dockerfile`
- Create: `tests/client-integration-server.test.ts`

**Interfaces:**
- Consumes: generated `dist/client-integration` from Task 2 and release metadata from Task 1.
- Produces: unauthenticated GET `/client-integration/manifest.json`, `/client-integration/releases/:version/:file`; extended `get_server_info.client_integration`.

- [ ] **Step 1: Write failing server tests**

Start the Fastify app against a temporary generated release tree and assert: manifest returns JSON; package returns expected content type/body; traversal attempts are rejected; missing release is 404; endpoints do not require MCP auth; cache headers are appropriate for manifest versus immutable versioned packages.

- [ ] **Step 2: Add `get_server_info` tests**

Assert the MCP result includes `latest_version`, `minimum_supported_version`, and `manifest_path: "/client-integration/manifest.json"` derived from the canonical release metadata.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `node --import tsx --test tests/client-integration-server.test.ts`

Expected: FAIL because routes/diagnostics do not exist.

- [ ] **Step 4: Implement static release routes safely**

Resolve only explicit manifest and release filenames under the configured/generated client integration directory; reject `..`, encoded traversal, unknown package names, and directories. Do not expose arbitrary `/app` files.

- [ ] **Step 5: Extend `get_server_info`**

Load canonical release metadata once and add `client_integration` diagnostics without making SessionStart depend on MCP availability.

- [ ] **Step 6: Update Docker build order**

Run `npm run build:client-integration` in the build stage before the runtime image copy, and copy `/app/dist/client-integration` into the runtime image together with compiled server output.

- [ ] **Step 7: Run focused tests and Docker artifact smoke check**

Run:

```bash
node --import tsx --test tests/client-integration-server.test.ts
npm run build:client-integration
npm run build
```

Expected: PASS; generated release tree remains present for Docker packaging.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/mcp.ts Dockerfile tests/client-integration-server.test.ts
git commit -m "feat: serve client integration releases"
```

### Task 7: Bootstrap existing Codex and Claude installations into the runtime

**Files:**
- Modify: `scripts/setup-codex-mcp.sh`
- Modify: `scripts/setup-codex-mcp.ps1`
- Modify: `scripts/setup-claude-code.sh`
- Modify: `scripts/setup-claude-code.ps1`
- Create: `tests/client-integration-bootstrap.test.ts`
- Modify: `tests/claude-setup-permissions.test.ts`

**Interfaces:**
- Consumes: Task 3 runtime layout and Task 5 updater behavior.
- Produces: one-time bootstrap installation of launcher + initial release + `state.json`; keeps `--upgrade` as migration/disaster-recovery entry only.

- [ ] **Step 1: Write failing bootstrap tests**

Cover Bash setup for both clients with custom homes and fake CLIs. Assert state contains absolute `config_home`, `hub_base_url` without `/mcp`, server name/API-key env name, client enabled flags, installed version, and no API-key value. Repeated bootstrap must be idempotent.

- [ ] **Step 2: Add divergent-Hub test**

Preconfigure Codex and Claude to different Hub URLs, then bootstrap the second client. Assert setup exits non-zero with a clear message and leaves the existing state/config unchanged.

- [ ] **Step 3: Add PowerShell parity assertions**

At minimum source-level contract tests must assert both PowerShell scripts install the same runtime/state fields and SessionStart hook commands; on Windows acceptance in Task 9, execute them for real.

- [ ] **Step 4: Run focused tests and verify failure**

Run:

```bash
node --import tsx --test tests/client-integration-bootstrap.test.ts
node --import tsx --test tests/claude-setup-permissions.test.ts
```

Expected: new bootstrap tests FAIL before setup changes; existing permission tests stay green.

- [ ] **Step 5: Refactor setup scripts to bootstrap runtime**

Preserve current config merge behavior, but source hook runtime/schema versions from the canonical generated release metadata/package rather than four independent constants. Install the stable launcher, initial release, state, and SessionStart runtime hook. `--upgrade` reuses recorded settings and remains usable when the launcher is damaged.

- [ ] **Step 6: Verify no secret values enter state/package**

Add assertions scanning generated state and package metadata for the fake API-key value; only the configured environment variable name may appear.

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --import tsx --test tests/client-integration-bootstrap.test.ts
node --import tsx --test tests/claude-setup-permissions.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/setup-codex-mcp.sh scripts/setup-codex-mcp.ps1 scripts/setup-claude-code.sh scripts/setup-claude-code.ps1 tests/client-integration-bootstrap.test.ts tests/claude-setup-permissions.test.ts
git commit -m "feat: bootstrap versioned client runtime"
```

### Task 8: Add version-bump CI/release safeguards

**Files:**
- Modify: `src/cli/release-check.ts`
- Create: `src/cli/client-integration-version-check.ts`
- Create: `tests/client-integration-version-check.test.ts`
- Modify: `.github/workflows/docker-image.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: canonical `client-integration/release.json` and generated package outputs.
- Produces: CI failure when client-integration-owned sources change without an intentional client version bump; package consistency verification in release checks.

- [ ] **Step 1: Write failing version-gate tests**

Create fixture git histories/temp trees covering: setup/hook/guidance/runtime changed and version unchanged => fail; only server code changed => pass; client files changed and version bumped => pass; `minimumSupportedVersion` policy-only change without package content change => allowed when primary version remains unchanged.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --import tsx --test tests/client-integration-version-check.test.ts`

Expected: FAIL because the gate does not exist.

- [ ] **Step 3: Implement the version gate**

Define the owned path set explicitly: setup scripts, Team Skill Hub hook scripts, `client-integration/**`, and managed guidance template sources. Compare against a caller-supplied/base git ref suitable for CI; do not infer version changes from timestamps.

- [ ] **Step 4: Extend release/package consistency checks**

Have release validation assert generated manifest matches canonical release metadata, both platform archives exist, and SHA-256 values recompute correctly.

- [ ] **Step 5: Wire CI**

Run client build + version gate + package consistency before Docker build in `.github/workflows/docker-image.yml`.

- [ ] **Step 6: Run focused tests and release checks**

Run:

```bash
node --import tsx --test tests/client-integration-version-check.test.ts
npm run build:client-integration
npm run release:check
```

Expected: PASS in the intended release state.

- [ ] **Step 7: Commit**

```bash
git add src/cli/release-check.ts src/cli/client-integration-version-check.ts tests/client-integration-version-check.test.ts .github/workflows/docker-image.yml package.json
git commit -m "ci: guard client integration release versions"
```

### Task 9: Real CLI acceptance on WSL2 and Windows PowerShell

**Files:**
- Create: `scripts/acceptance-client-integration-wsl.sh`
- Create: `scripts/acceptance-client-integration.ps1`
- Modify: `docs/repository/client-integration.md`
- Modify: `docs/developer/developer-guide.md`
- Modify: `docs/developer/developer-guide.zh-CN.md`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: repeatable acceptance scripts and operator/developer documentation for bootstrap, update notices, explicit upgrade, rollback, doctor, and disaster recovery.

- [ ] **Step 1: Add WSL2 acceptance script**

Automate a disposable HOME/CODEX_HOME/CLAUDE_CONFIG_DIR against a local Team Skill Hub server. Verify no-update silence, optional/required notices, cache behavior, explicit upgrade, concurrent session checks, exclusive mutation lock, custom homes, restart notice, and rollback with server unavailable.

- [ ] **Step 2: Run WSL2 acceptance with real Codex and Claude CLIs**

Run: `bash scripts/acceptance-client-integration-wsl.sh`

Expected: PASS, including proof that each client's actual SessionStart hook contract displays the intended notice and does not treat it as control output.

- [ ] **Step 3: Add equivalent PowerShell acceptance**

Cover bootstrap/upgrade/rollback and real Windows path semantics, including launcher replacement/pending replacement behavior when a script is locked.

- [ ] **Step 4: Run Windows PowerShell acceptance**

Run from Windows PowerShell: `./scripts/acceptance-client-integration.ps1`

Expected: PASS.

- [ ] **Step 5: Update client integration documentation**

Document normal flow (`session-start` notice -> user says upgrade -> `upgrade` -> restart), local files, `doctor`, `rollback`, custom homes, release retention, no-API-key release endpoints, and `setup --upgrade` only as bootstrap/disaster recovery.

- [ ] **Step 6: Run the complete repository validation**

Run:

```bash
npm run build:client-integration
npm run build
npm test
npm run release:check
```

Expected: all commands PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/acceptance-client-integration-wsl.sh scripts/acceptance-client-integration.ps1 docs/repository/client-integration.md docs/developer/developer-guide.md docs/developer/developer-guide.zh-CN.md
git commit -m "test: add client integration acceptance coverage"
```

### Task 10: Final cross-cutting review and release-readiness verification

**Files:**
- Review only unless defects are found.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: release-ready evidence that the spec is implemented without regressions.

- [ ] **Step 1: Re-read the design spec against implementation**

Check every requirement in `docs/superpowers/specs/2026-10-15-client-integration-update-design.md` against code/tests. Pay special attention to crash recovery, custom config homes, no silent upgrades, relative URLs, and server-owned API compatibility.

- [ ] **Step 2: Run full validation from a clean generated-output state**

Remove only generated `dist/client-integration`, rebuild it, then run `npm run build && npm test && npm run release:check`.

Expected: PASS with no dependency on stale generated files.

- [ ] **Step 3: Inspect generated packages**

Verify manifest/package version agreement, archive required files, current SHA-256 values, absence of secret-like files, and no absolute developer-machine paths in package/state fixtures.

- [ ] **Step 4: Re-run interruption/concurrency focused tests**

Run the runtime/updater/session-start/bootstrap focused test files together and confirm all crash points and competing-session cases pass.

- [ ] **Step 5: Perform whole-branch code review**

Review for duplicate version constants, config clobbering, unsafe path resolution, unbounded network waits, launcher/updater responsibility leakage, and accidental API-key logging.

- [ ] **Step 6: Commit any review fixes separately and rerun affected tests**

Expected: final branch contains only verified changes and documentation consistent with the shipped behavior.
