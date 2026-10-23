# Standalone Expert Worker Runtime

This is the deployment-package definition for the Expert Worker daemon. The release artifact is assembled from the compiled Worker dependency closure; it does not include the Hub server, Admin UI, MCP server, or knowledge-management source.

## Requirements

- Linux x86_64/arm64 supported by the selected Node.js 24 build and Docker Engine.
- Node.js 24.x, Docker Engine, network access to the Hub gRPC endpoint and configured Git remotes.
- A stable Worker ID and capability. By default, the Worker uses a bootstrap token to register and waits for Admin approval; no manual credential copy is needed.
- The matching `team-skill-hub-expert-worker:<version>` execution image, built/published separately. The Hub development checkout can build/export it with `scripts/build-worker-execution-image.sh <version>`; the Worker host only needs the resulting image archive (`docker load -i ...`), not the Dockerfile or Hub source.

## Build artifact (run in the Hub development checkout)

```bash
npm run build:worker-runtime
```

Output: `artifacts/worker-runtime/worker-runtime-<version>.tar.gz`. Only deploy this artifact, not the Hub checkout.

## Install on a Worker host

```bash
mkdir -p /tmp/worker-runtime-bootstrap
tar -xzf worker-runtime-<version>.tar.gz -C /tmp/worker-runtime-bootstrap
sudo /tmp/worker-runtime-bootstrap/install-worker.sh worker-runtime-<version>.tar.gz
sudoedit /etc/team-skill-hub-worker/worker.env
sudo chmod 600 /etc/team-skill-hub-worker/worker.env
# Load the matching execution image separately:
sudo docker load -i expert-worker-image-<version>.tar
sudo systemctl enable --now team-skill-hub-worker
sudo systemctl status team-skill-hub-worker
sudo journalctl -u team-skill-hub-worker -n 100 --no-pager
```

Set `EXPERT_HUB_ADDRESS`, `EXPERT_WORKER_ID`, `EXPERT_CAPABILITY` and `EXPERT_WORKER_BOOTSTRAP_TOKEN` in the protected environment file. The Worker registers automatically. Admin approval is required by default; the Worker creates a protected pending credential locally before registration and submits it to the Hub over the configured gRPC transport. The Hub stores only its hash. After approval, the same credential is activated and atomically moved to `EXPERT_WORKER_CREDENTIAL_FILE` (default `/var/lib/team-skill-hub-worker/worker-credential`) with mode `0600`. If the network response is lost, the Worker retries with the same pending credential. After verifying the credential file exists, remove the bootstrap token from `worker.env`; on later restarts, the saved credential is reused. The environment file contains secrets and must never be committed or printed in logs.

Each Worker ID gets a private repository namespace under `EXPERT_REPOSITORY_ROOT`; do not point multiple Workers at a shared checkout.

### Codex sandbox / seccomp on WSL2

Keep `EXPERT_DOCKER_SECCOMP_PROFILE=default` as the baseline. On some WSL2/Linux hosts, Codex's nested read-only sandbox cannot start under Docker's default seccomp profile; tasks may return an environment/sandbox error even though the container exits normally. Only after reproducing that issue, explicitly test `EXPERT_DOCKER_SECCOMP_PROFILE=unconfined`. This disables the Docker seccomp filter for the execution container and weakens one defense-in-depth layer; it does **not** make the container privileged, and the executor still applies a read-only root filesystem, drops Linux capabilities, disables privilege escalation, limits memory/CPU/PIDs, and mounts the source workspace read-only. Validate this trade-off for the deployment environment before enabling it.
