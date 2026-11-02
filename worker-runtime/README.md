# Standalone Expert Worker Runtime

The Worker Runtime package installs the host-side Expert Worker daemon. It does not include the Hub server, Admin UI, MCP server, or knowledge-management source.

## Deployment model

One host installs the Runtime once and may run multiple independent Worker instances:

```text
/opt/team-skill-hub-worker/current
  shared immutable Runtime

/etc/team-skill-hub-worker/workers/<instance>.env
  one runnable config per Worker instance

/etc/team-skill-hub-worker/instances/<instance>/keys/
  instance-local secret files

/var/lib/team-skill-hub-worker/<instance>/
  credential, PID, log, source and repository state
```

The host-local instance name is not the same thing as `EXPERT_WORKER_ID`. The instance name controls local paths and service names; `EXPERT_WORKER_ID` is the logical Worker identity registered with the Hub.

## Requirements

- Linux x86_64/arm64 supported by Node.js 24 and Docker Engine.
- Node.js 24.x and Docker Engine.
- Network access to the Hub gRPC endpoint, configured Git remotes, model endpoints, and optional Skill Hub MCP endpoint.
- Matching Claude/Codex execution images supplied separately.
- `systemd` is optional.

## Build

From a Hub development checkout:

```bash
npm run build:worker-runtime
```

Output:

```text
artifacts/worker-runtime/worker-runtime-<version>.tar.gz
```

Deploy this artifact to Worker hosts; do not deploy the Hub source tree.

## Install the shared Runtime

```bash
mkdir -p /tmp/worker-runtime-bootstrap
tar -xzf worker-runtime-<version>.tar.gz -C /tmp/worker-runtime-bootstrap
sudo /tmp/worker-runtime-bootstrap/install-worker.sh worker-runtime-<version>.tar.gz
```

The installer:

- installs/updates the shared Runtime under `/opt/team-skill-hub-worker`;
- installs `/etc/team-skill-hub-worker/worker.env.example`;
- creates the shared `workers/` and `instances/` roots;
- installs `team-skill-hub-worker@.service` when a running systemd manager is detected;
- does **not** create or start a Worker instance.

If legacy `/etc/team-skill-hub-worker/worker.env` exists, the installer warns that it is no longer consumed. Review and migrate settings into a named instance; credentials and repository state are not migrated automatically.

## Create Worker instances

```bash
sudo /opt/team-skill-hub-worker/current/worker-control.sh init claude-01
sudo /opt/team-skill-hub-worker/current/worker-control.sh init codex-01
```

This creates:

```text
/etc/team-skill-hub-worker/workers/claude-01.env
/etc/team-skill-hub-worker/instances/claude-01/keys/
/var/lib/team-skill-hub-worker/claude-01/
```

and the equivalent paths for `codex-01`.

Edit each generated env file. The launcher injects `EXPERT_WORKER_INSTANCE`; do not set it manually.

Unless explicitly overridden, these paths are derived automatically:

```text
/var/lib/team-skill-hub-worker/<instance>/worker-credential
/var/lib/team-skill-hub-worker/<instance>/source
/var/lib/team-skill-hub-worker/<instance>/repositories
```

## Inventory

```bash
sudo /opt/team-skill-hub-worker/current/worker-control.sh list
sudo /opt/team-skill-hub-worker/current/worker-control.sh list --json
```

The human view shows instance, Worker ID, backend, capability, runtime profiles, process status, and PID. One malformed config is reported as `invalid-config` without hiding valid instances. `stale-pid` means PID/start metadata exists but no matching Worker process is running.

Neither inventory form prints tokens, credentials, key contents, or model secrets.

## Manual lifecycle

On hosts without systemd:

```bash
sudo /opt/team-skill-hub-worker/current/worker-control.sh claude-01 start
sudo /opt/team-skill-hub-worker/current/worker-control.sh claude-01 status
sudo /opt/team-skill-hub-worker/current/worker-control.sh claude-01 logs
sudo /opt/team-skill-hub-worker/current/worker-control.sh claude-01 restart
sudo /opt/team-skill-hub-worker/current/worker-control.sh claude-01 stop
```

Repeat independently for other instances. PID, process start time, logs, credentials, source, and repository roots are instance-local.

Manual mode runs the daemon as `expert-worker`. It does not automatically restart crashed Workers or enable start-on-boot; use systemd or another trusted supervisor when required.

## systemd lifecycle

```bash
sudo systemctl enable --now team-skill-hub-worker@claude-01
sudo systemctl enable --now team-skill-hub-worker@codex-01

sudo systemctl status team-skill-hub-worker@claude-01
sudo journalctl -u team-skill-hub-worker@claude-01 -n 100 --no-pager
```

Do not run the same instance through both systemd and `worker-control.sh`. A different instance may use the other control mode independently.

## Registration and credentials

Each instance config sets at least:

```dotenv
EXPERT_HUB_ADDRESS=hub.internal.example:7443
EXPERT_WORKER_ID=ota-claude-worker-01
EXPERT_CAPABILITY=ota
EXPERT_WORKER_BOOTSTRAP_TOKEN=replace-with-deployment-bootstrap-token
EXPERT_EXECUTOR_BACKEND=claude
EXPERT_RUNTIME_PROFILES=claude-readonly
EXPERT_DOCKER_IMAGE=team-skill-hub-expert-claude:0.1.0
EXPERT_DOCKER_NETWORK=bridge
EXPERT_MODEL_ENV_NAMES=ANTHROPIC_AUTH_TOKEN,HTTPS_PROXY,NO_PROXY
```

After Admin approval, the Worker stores its credential under the instance data directory with mode `0600`. Remove the bootstrap token from that instance's env file after confirming the credential exists.

Put MCP/Git credential files under:

```text
/etc/team-skill-hub-worker/instances/<instance>/keys/
```

Never share repository checkouts between Worker instances.

## Claude and Codex on one host

A typical host may run:

```text
claude-01
  EXPERT_EXECUTOR_BACKEND=claude
  EXPERT_RUNTIME_PROFILES=claude-readonly

codex-01
  EXPERT_EXECUTOR_BACKEND=codex
  EXPERT_RUNTIME_PROFILES=codex-readonly
```

They share the Runtime and Docker Engine but use separate instance configs, credentials, repository roots, logs, and process state.

## Codex sandbox / seccomp on WSL2

Keep `EXPERT_DOCKER_SECCOMP_PROFILE=default` as the baseline. On WSL2/Linux hosts where Codex nested sandbox initialization fails under Docker's default seccomp policy, reproduce the issue first and then explicitly test `unconfined`. This weakens one defense-in-depth layer; the task container must remain non-privileged, read-only where designed, capability-restricted, and resource-limited.
