# Worker Custom Install Directory and No-Systemd Implementation Plan

> **For agentic workers:** Execute task-by-task using Superpowers TDD. Steps use checkbox syntax.

**Goal:** Add `--install-dir PATH` and `--no-systemd` to Worker installation while making worker-control resolve runtime paths from its own location.

**Architecture:** Keep release/current layout and global config/data locations. Resolve install paths once in the installer, make control scripts self-relocating, and generate systemd units from the resolved absolute path only in systemd mode.

**Tech Stack:** Bash, systemd unit templates, Node.js test runner and existing shell-script tests.

**Spec:** `docs/superpowers/specs/2026-11-05-worker-custom-install-dir-and-no-systemd-design.md`

## Global Constraints

- Default install path remains `/opt/team-skill-hub-worker`.
- Config remains `/etc/team-skill-hub-worker`; data remains `/var/lib/team-skill-hub-worker`.
- `--no-systemd` must not invoke systemctl or touch unit files.
- Runtime paths must be absolute and independent of caller cwd.
- Preserve release/current upgrade semantics and existing multi-instance behavior.
- Never modify unrelated `docker-compose.wsl2-override.yml`.

## Review Focus

- Install path contains spaces and is consistently quoted.
- Relative install paths resolve before privilege/path changes.
- `--no-systemd` on a systemd host performs zero systemctl/unit side effects.
- Existing systemd unit cleanup cannot remove unrelated or pre-existing units in no-systemd mode.
- Upgrades preserve global config/data and update only intended runtime links/units.

---

### Task 1: Installer CLI and install-directory resolution

**Files:**

- Modify: `worker-runtime/install-worker.sh`
- Test: `tests/expert-platform-worker-install-scripts.test.ts`

**Interfaces:** Installer accepts archive followed by `--install-dir PATH` and optional `--no-systemd`; default path remains unchanged.

- [ ] Add tests asserting absolute custom path, relative path canonicalization, space-containing path quoting, default path compatibility, and errors for missing/empty option values.
- [ ] Run the focused test and confirm it fails because current installer rejects/ignores the options or hardcodes the path.
- [ ] Implement argument parsing and canonicalize the chosen install path before installation operations; use quoted variables for all filesystem operations.
- [ ] Run focused tests and confirm all path/CLI assertions pass.

### Task 2: Self-relocating worker-control

**Files:**

- Modify: `worker-runtime/worker-control.sh`
- Test: `tests/expert-platform-worker-install-scripts.test.ts`

**Interfaces:** `worker-control.sh` resolves its runtime root and Node path from the real script path under `current`/release; existing subcommand syntax remains compatible.

- [ ] Add tests that install to a temporary custom directory with spaces, invoke control from an unrelated cwd, and verify the selected release and bundled Node are used.
- [ ] Run focused test and confirm it fails under fixed `/opt` assumptions.
- [ ] Implement script-directory resolution using the physical script path and quote all derived paths.
- [ ] Run focused tests and confirm manual control works from arbitrary cwd.

### Task 3: Conditional systemd setup and dynamic unit paths

**Files:**

- Modify: `worker-runtime/install-worker.sh`
- Modify: `worker-runtime/team-skill-hub-worker@.service` or existing unit generation template
- Test: `tests/expert-platform-worker-install-scripts.test.ts`

**Interfaces:** Installer selects `systemd` or `manual` mode once. Manual mode bypasses all systemctl and unit file operations; systemd mode renders absolute paths for the resolved install directory.

- [ ] Add tests simulating a systemd host with `--no-systemd`, asserting no systemctl invocation and no unit create/modify/delete; add systemd-mode assertions for custom `ExecStart`, `ExecStop`, Node and WorkingDirectory paths.
- [ ] Run focused tests and confirm they fail with current unconditional/directory-fixed systemd behavior.
- [ ] Implement explicit mode precedence and dynamic unit rendering. Keep existing unit cleanup/security logic exclusively in systemd mode.
- [ ] Run focused tests and confirm both modes pass.

### Task 4: Upgrade, documentation and install output

**Files:**

- Modify: `worker-runtime/install-worker.sh`
- Modify: `worker-runtime/worker-control.sh` only if command help/output needs alignment
- Modify: `docs/expert-platform/add-expert.md`
- Test: `tests/expert-platform-worker-install-scripts.test.ts`

- [ ] Add tests verifying repeated install/upgrade keeps `/etc/team-skill-hub-worker` and `/var/lib/team-skill-hub-worker` intact and that manual-mode output includes exact init/start/list commands using the custom path.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement safe upgrade behavior and shell-quoted manual command output; document both modes and examples.
- [ ] Run focused tests and confirm they pass.

### Task 5: Final verification

- [ ] Run `bash -n` on changed shell scripts.
- [ ] Run `npm run format:check`, `npm run lint`, `npm run build`, and the complete test suite using repository-supported commands.
- [ ] Run an isolated end-to-end install in a temporary path containing spaces; test manual control from another cwd.
- [ ] Run a systemd-mode fixture test and a `--no-systemd` fixture on a simulated systemd host; verify no systemctl/unit touch in manual mode.
- [ ] Review complete diff and confirm only intended files changed; preserve the untracked compose override.
