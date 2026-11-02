# Multi-Instance Expert Worker Runtime Design

## Status

Approved direction, pending implementation plan.

## Intent

Allow one Linux host to run multiple independent Team Skill Hub Expert Worker instances while sharing one installed Worker Runtime.

The current Worker daemon and Hub scheduling model already support multiple Worker identities. The deployment package is the limiting layer because it assumes one global config file, one PID/log/credential location, one repository root, and one systemd service.

The new model is:

```text
one host
  + one shared Worker Runtime
  + N independently configured Worker instances
```

Each Worker instance represents one operational execution profile/capability set. A host may therefore run, for example, a Claude OTA Worker and a Codex OTA Worker at the same time.

## Goals

- Support multiple Worker instances on one host.
- Install the Worker Runtime only once.
- Isolate instance config, credentials, PID state, logs, source/repository checkouts, and secret files.
- Support both systemd and non-systemd/manual hosts.
- Make Worker inventory visible with `worker-control.sh list`.
- Keep the Hub Worker identity separate from the host-local instance name.
- Fail clearly on the old single-instance `/etc/team-skill-hub-worker/worker.env`; do not silently preserve the old runtime behavior.
- Keep task execution and Hub scheduling architecture unchanged.

## Non-goals

- A single Worker daemon dynamically switching between unrelated Worker identities.
- Sharing one source checkout between Worker instances.
- Migrating old single-instance files automatically without administrator review.
- Changing Expert routing or Deployment selection semantics.
- Moving Worker lifecycle management into the Hub Admin UI in this change.

## Approaches considered

### 1. Install one full Runtime per Worker

Example:

```text
/opt/team-skill-hub-worker-claude
/opt/team-skill-hub-worker-codex
```

This isolates instances but duplicates Runtime installation, upgrade logic, service files, and release management.

Rejected because the Runtime is identical and should be host-scoped, not instance-scoped.

### 2. Shared Runtime + isolated Worker instances

Example:

```text
/opt/team-skill-hub-worker/current

/etc/team-skill-hub-worker/workers/claude-01.env
/etc/team-skill-hub-worker/workers/codex-01.env

/var/lib/team-skill-hub-worker/claude-01/
/var/lib/team-skill-hub-worker/codex-01/
```

Selected approach.

It keeps Runtime upgrades simple while making all mutable and secret state instance-local.

### 3. One universal Worker daemon for Claude + Codex

A single daemon could advertise several runtime profiles and launch different execution containers.

This remains technically possible, but it combines Worker identity, credentials, Docker images, model environment variables, MCP credentials, seccomp behavior, and operational failure domains.

Rejected for the current deployment model. Prefer one Worker instance per operational capability/profile, with multiple instances per host.

## Host layout

### Shared immutable Runtime

```text
/opt/team-skill-hub-worker/
├── releases/
│   └── <version>/
└── current -> releases/<version>
```

Installed once by `install-worker.sh`.

### Configuration

```text
/etc/team-skill-hub-worker/
├── worker.env.example
├── workers/
│   ├── claude-01.env
│   ├── codex-01.env
│   └── review-01.env
└── instances/
    ├── claude-01/
    │   └── keys/
    ├── codex-01/
    │   └── keys/
    └── review-01/
        └── keys/
```

`worker.env.example` is a template only. No Worker process reads it directly.

A runnable Worker always has an instance config:

```text
/etc/team-skill-hub-worker/workers/<instance>.env
```

### Mutable instance state

```text
/var/lib/team-skill-hub-worker/
├── claude-01/
│   ├── worker.pid
│   ├── worker.pid.start
│   ├── worker.log
│   ├── worker-credential
│   ├── source/
│   └── repositories/
├── codex-01/
│   └── ...
└── review-01/
    └── ...
```

PID, log, Worker credential, source path, and repository checkout are never shared between Worker instances.

## Instance name vs Worker ID

The host-local instance name and Hub Worker ID are distinct concepts.

Example:

```text
instance name:
  claude-01

EXPERT_WORKER_ID:
  ota-claude-worker-prod-01
```

The instance name is an operational identifier used for paths and service names.

The Worker ID is the logical identity registered in the Hub.

Renaming/re-registering a Hub Worker must not require renaming all host-local files.

## Instance environment

The launcher injects:

```bash
EXPERT_WORKER_INSTANCE=<instance>
```

Administrators normally do not set it manually.

The Worker/runtime helpers derive instance-local defaults from this value:

```text
EXPERT_WORKER_CREDENTIAL_FILE
  /var/lib/team-skill-hub-worker/<instance>/worker-credential

EXPERT_REPOSITORY_ROOT
  /var/lib/team-skill-hub-worker/<instance>/repositories

EXPERT_SOURCE_PATH
  /var/lib/team-skill-hub-worker/<instance>/source
```

Explicit environment values may override these defaults when needed.

The config template should document the derived defaults rather than writing single-instance paths into each generated config.

## Secret isolation

Each instance has its own root-owned key directory:

```text
/etc/team-skill-hub-worker/instances/<instance>/keys/
```

Examples:

```text
/etc/team-skill-hub-worker/instances/claude-01/keys/skillhub-readonly
/etc/team-skill-hub-worker/instances/claude-01/keys/ota-github-readonly

/etc/team-skill-hub-worker/instances/codex-01/keys/skillhub-readonly
/etc/team-skill-hub-worker/instances/codex-01/keys/ota-github-readonly
```

Credential mapping variables may reference these files.

No `list`, `status`, or validation output may print secret values.

## Runtime installation

`install-worker.sh` becomes host-scoped.

Responsibilities:

- install/update `/opt/team-skill-hub-worker/releases/<version>`
- update the shared `current` symlink
- create shared configuration directories
- install `worker.env.example`
- install the systemd template when systemd is active
- create the common `expert-worker` user/group if needed
- do not create a runnable `worker.env`
- do not create a Worker instance automatically

The installer must detect the legacy file:

```text
/etc/team-skill-hub-worker/worker.env
```

and print a clear migration warning. The new controller and systemd template must never read that file.

## Worker controller CLI

### Host-level commands

```bash
worker-control.sh init <instance>
worker-control.sh list
worker-control.sh list --json
```

### Instance-level commands

```bash
worker-control.sh <instance> start
worker-control.sh <instance> stop
worker-control.sh <instance> restart
worker-control.sh <instance> status
worker-control.sh <instance> logs
```

Calling an instance-level command without an instance is an error.

### Instance validation

Instance names must use a constrained safe format suitable for filesystem paths and systemd instance names.

Recommended initial rule:

```text
^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
```

Reject path separators, whitespace, `..`, shell metacharacters, and empty names.

## `init` behavior

```bash
worker-control.sh init claude-01
```

creates:

```text
/etc/team-skill-hub-worker/workers/claude-01.env
/etc/team-skill-hub-worker/instances/claude-01/keys/
/var/lib/team-skill-hub-worker/claude-01/
```

The env file is copied from the shared `worker.env.example`.

`init`:

- fails if the instance already exists unless a future explicit overwrite option is introduced
- sets secure ownership/permissions
- does not generate or copy real API keys
- does not automatically start the Worker
- prints the next configuration/start commands

## `list` behavior

`worker-control.sh list` scans:

```text
/etc/team-skill-hub-worker/workers/*.env
```

and combines config metadata with process/PID state.

Human-readable output should include at least:

```text
INSTANCE    WORKER_ID              BACKEND   CAPABILITY   PROFILES          STATUS          PID
claude-01   ota-claude-worker-01   claude    ota          claude-readonly   running         21676
codex-01    ota-codex-worker-01    codex     ota          codex-readonly    stopped         -
review-01   -                      claude    -            -                 invalid-config  -
```

Rules:

- one invalid config must not prevent other instances from being listed
- missing/invalid PID state is reported per instance
- output never prints credentials, tokens, key contents, model secrets, or secret environment values
- stable sorting is by instance name

### JSON inventory

```bash
worker-control.sh list --json
```

returns a stable machine-readable array such as:

```json
[
  {
    "instance": "claude-01",
    "workerId": "ota-claude-worker-01",
    "backend": "claude",
    "capability": "ota",
    "runtimeProfiles": ["claude-readonly"],
    "status": "running",
    "pid": 21676
  }
]
```

Allowed status values for the first implementation:

```text
running
stopped
invalid-config
stale-pid
```

JSON output must contain no human prose on stdout. Errors that make the whole inventory impossible go to stderr and return non-zero.

## Manual process management

Each instance uses:

```text
DATA=/var/lib/team-skill-hub-worker/<instance>
PID_FILE=$DATA/worker.pid
START_FILE=$DATA/worker.pid.start
LOG_FILE=$DATA/worker.log
CONFIG=/etc/team-skill-hub-worker/workers/<instance>.env
```

The existing PID + process start-time safety check is retained.

Process identity checking should additionally verify the expected `EXPERT_WORKER_INSTANCE`/config context where practical, so one instance cannot stop another Worker process merely because both run the same Node script.

Manual mode must continue to drop privileges to `expert-worker`.

## systemd

Replace the fixed unit with:

```text
team-skill-hub-worker@.service
```

Example:

```bash
systemctl enable --now team-skill-hub-worker@claude-01
systemctl enable --now team-skill-hub-worker@codex-01
```

The template injects:

```ini
Environment=EXPERT_WORKER_INSTANCE=%i
EnvironmentFile=/etc/team-skill-hub-worker/workers/%i.env
```

The service invokes the shared Runtime.

Instance-specific writable state must be restricted to that instance's data directory. Implementation must verify how systemd specifier expansion behaves in `ReadWritePaths=`; if unsuitable, use a small shared launcher/wrapper that validates the instance and establishes the correct data path rather than weakening filesystem restrictions globally.

The manual controller must detect only the matching systemd instance:

```text
team-skill-hub-worker@<instance>.service
```

It must not reject manual control just because a different Worker instance is managed by systemd.

## Config validation

`check-worker-config.js` must become instance-aware.

It must:

- accept the injected `EXPERT_WORKER_INSTANCE`
- derive instance-local default paths
- validate required Worker settings
- validate that configured credential/key paths stay inside explicitly allowed locations where applicable
- never print secret values

Validation should be reusable by:

- systemd `ExecStartPre`
- manual `start`
- `list` per-instance inspection

Invalid config for one instance must not break inventory of other instances.

## Legacy single-instance configuration

The new runtime does not support the old runnable file:

```text
/etc/team-skill-hub-worker/worker.env
```

If it exists, startup without a valid instance configuration must fail with an explicit migration message.

Example:

```text
Legacy single-worker configuration detected:
/etc/team-skill-hub-worker/worker.env

This runtime no longer reads that file.

Create an instance:
  worker-control.sh init default

Then migrate reviewed settings to:
  /etc/team-skill-hub-worker/workers/default.env
```

No automatic migration of credentials or repository directories is performed.

The administrator may choose the instance name `default`, but it has no special runtime semantics.

## Upgrade behavior

A Runtime upgrade replaces only the shared `/opt/team-skill-hub-worker/current` target.

Instance configs/data remain untouched.

Running Worker processes continue using the executable/modules they loaded until restarted. Administrators restart instances explicitly or through systemd rollout policy.

The installer must not silently restart all Worker instances.

## Worker/Deployment relationship

This change does not bind one Worker ID permanently to one Deployment.

The existing Hub claim compatibility remains authoritative:

- Worker capabilities
- executor backend
- runtime profiles

Operationally, the recommended deployment is one Worker instance per execution capability/profile set.

Examples:

```text
claude-ota-01
  backend=claude
  profiles=claude-readonly
  capability=ota

codex-ota-01
  backend=codex
  profiles=codex-readonly
  capability=ota
```

The Hub may route compatible Deployment tasks to either matching Worker instance.

## Concurrency and repository isolation

Multiple instances may run concurrently on one host.

Each must use a different `EXPERT_REPOSITORY_ROOT`.

Do not share checked-out repositories between Workers.

Docker execution containers may share immutable Docker images and Docker Engine, but task workspaces/state remain isolated by Worker instance and task.

## Failure handling

- Invalid instance name: fail before reading/writing instance paths.
- Missing instance env: instance command fails with setup guidance.
- Invalid config: `start` fails; `list` reports `invalid-config`.
- Stale PID: `status`/inventory reports `stale-pid`; stop logic must not signal an unrelated process.
- One Worker crash does not affect other Worker instances.
- One malformed env file does not prevent `list` from displaying valid instances.
- Shared Runtime missing/broken: affected commands fail globally with an installation error.

## Security properties

- Shared Runtime remains root-owned and not writable by `expert-worker`.
- Instance env files remain root-owned mode 0600.
- Instance key files remain protected.
- Mutable data is separated per instance.
- Manual controller validates instance names before constructing paths.
- No secret values appear in `list`, logs generated by config validation, or error messages.
- Docker group membership remains root-equivalent and the existing dedicated trusted Worker host warning remains applicable.

## Testing and acceptance

Implementation must include automated tests for:

1. two Worker instances can coexist with different config/data paths
2. controller cannot stop one instance using another instance's PID file
3. `list` shows multiple configured Workers
4. `list --json` is valid JSON and contains no secret values
5. invalid instance config is isolated to that row
6. stale PID detection remains safe
7. legacy `worker.env` is not consumed
8. systemd template resolves instance env correctly
9. manual controller only conflicts with the matching systemd instance
10. repository roots and Worker credentials are instance-local
11. shared Runtime upgrade leaves instance config/data untouched

Real acceptance on WSL2/Linux should run at least two simultaneous Workers, for example Claude and Codex, and dispatch one task to each to prove both can remain registered and execute independently.

## Documentation changes

Update:

- `worker-runtime/README.md`
- `worker-runtime/worker.env.example`
- Expert Platform deployment documentation
- worker installation instructions

Documentation must make the distinction clear:

```text
install Runtime once
init Worker instances many times
start/stop/list instances independently
```
