import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const runtime = new URL("../worker-runtime/", import.meta.url);
const packageScript = readFileSync(new URL("../scripts/package-worker-runtime.mjs", import.meta.url), "utf8");

function controllerFixture(options: { runtimeNode?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "skillhub-worker-control-"));
  const etc = path.join(root, "etc");
  const data = path.join(root, "data");
  const base = path.join(root, "runtime");
  mkdirSync(etc, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(base, { recursive: true });
  copyFileSync(new URL("worker.env.example", runtime), path.join(etc, "worker.env.example"));
  const script = new URL("worker-control.sh", runtime).pathname;
  const env = {
    ...process.env,
    WORKER_RUNTIME_ETC_ROOT: etc,
    WORKER_RUNTIME_DATA_ROOT: data,
    WORKER_RUNTIME_BASE: base,
    WORKER_RUNTIME_SKIP_ROOT_CHECK: "1",
    ...(options.runtimeNode === false ? {} : { WORKER_RUNTIME_NODE: process.execPath }),
    PATH: "/usr/bin:/bin",
  };
  return {
    etc,
    data,
    run(args: string[]) {
      return spawnSync("bash", [script, ...args], { env, encoding: "utf8" });
    },
  };
}

test("Worker installation and manual lifecycle scripts are valid Bash and included in release archive", () => {
  for (const script of ["install-worker.sh", "worker-control.sh"]) {
    const filename = new URL(script, runtime).pathname;
    assert.doesNotThrow(() => execFileSync("bash", ["-n", filename]));
    assert.match(packageScript, new RegExp(`"${script.replaceAll(".", "\\.")}"`));
  }
});

test("installer is host-scoped and runtime package uses a systemd template", () => {
  const installer = readFileSync(new URL("install-worker.sh", runtime), "utf8");
  const manual = readFileSync(new URL("worker-control.sh", runtime), "utf8");
  assert.match(installer, /\/run\/systemd\/system/);
  assert.match(installer, /systemctl show-environment/);
  assert.match(installer, /worker\.env\.example/);
  assert.match(installer, /workers/);
  assert.match(installer, /instances/);
  assert.match(installer, /Legacy single-worker configuration detected/);
  assert.match(installer, /team-skill-hub-worker\.service/);
  assert.match(installer, /systemctl is-active/);
  assert.match(installer, /systemctl is-enabled/);
  assert.match(installer, /NODE_BIN/);
  assert.match(installer, /\$BASE\/node/);
  assert.match(installer, /export PATH="\/usr\/sbin:/);
  assert.doesNotMatch(installer, /install -m 0600 .*worker\.env/);
  assert.match(packageScript, /team-skill-hub-worker@\.service/);
  assert.match(packageScript, /chmodSync\(path\.join\(stage, "team-skill-hub-worker@\.service"\), 0o644\)/);
  assert.match(packageScript, /mkdtempSync/);
  assert.match(packageScript, /tmpdir\(\)/);
  assert.doesNotMatch(packageScript, /"team-skill-hub-worker\.service"/);
  assert.match(manual, /runuser --user expert-worker --preserve-environment/);
  assert.match(manual, /worker_start_time/);
  assert.match(manual, /\/proc\/\$pid\/environ/);
  assert.match(manual, /EXPERT_WORKER_INSTANCE=\$INSTANCE/);
  for (const key of [
    "EXPERT_CODEX_AUTH_FILE",
    "EXPERT_CODEX_CONFIG_FILE",
    "EXPERT_TLS_CA_PATH",
    "EXPERT_TLS_CERT_PATH",
    "EXPERT_TLS_KEY_PATH",
    "EXPERT_CLAUDE_MODEL",
    "EXPERT_CLAUDE_MAX_TURNS",
  ]) {
    assert.match(manual, new RegExp(key));
  }
  assert.match(manual, /worker\.log/);
  assert.ok(
    manual.indexOf('-x "$HOST_ROOT/node"') < manual.indexOf("command -v node"),
    "controller should prefer the installer-pinned Node before PATH lookup",
  );
});

test("systemd template loads one instance config and isolates writable state", () => {
  const templateUrl = new URL("team-skill-hub-worker@.service", runtime);
  assert.equal(existsSync(templateUrl), true);
  const service = readFileSync(templateUrl, "utf8");
  assert.match(service, /Environment=EXPERT_WORKER_INSTANCE=%i/);
  assert.match(service, /Environment=PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/);
  assert.match(service, /EnvironmentFile=\/etc\/team-skill-hub-worker\/workers\/%i\.env/);
  assert.ok(
    service.indexOf("EnvironmentFile=/etc/team-skill-hub-worker/workers/%i.env") <
      service.indexOf("Environment=EXPERT_WORKER_INSTANCE=%i"),
  );
  assert.match(service, /ReadWritePaths=\/var\/lib\/team-skill-hub-worker\/%i/);
  assert.match(
    service,
    /ExecStart=\/opt\/team-skill-hub-worker\/node .*\/opt\/team-skill-hub-worker\/current\/src\/cli\/expert-worker\.js/,
  );
});
test("configuration checker runs as ESM in the packaged module", () => {
  const source = readFileSync(new URL("check-worker-config.js", runtime), "utf8");
  assert.match(source, /import \{ existsSync \} from "node:fs"/);
  assert.doesNotMatch(source, /require\(/);
});

test("worker env example documents instance-derived paths instead of runnable single-instance defaults", () => {
  const source = readFileSync(new URL("worker.env.example", runtime), "utf8");
  assert.match(source, /EXPERT_WORKER_INSTANCE/);
  assert.match(source, /<instance>/);
  assert.doesNotMatch(source, /^EXPERT_WORKER_CREDENTIAL_FILE=\/var\/lib\/team-skill-hub-worker\/worker-credential$/m);
  assert.doesNotMatch(source, /^EXPERT_SOURCE_PATH=\/var\/lib\/team-skill-hub-worker\/source$/m);
  assert.doesNotMatch(source, /^EXPERT_REPOSITORY_ROOT=\/var\/lib\/team-skill-hub-worker\/repositories$/m);
});

test("manual controller initializes isolated worker instances and rejects unsafe names", () => {
  const fx = controllerFixture();
  const created = fx.run(["init", "claude-01"]);
  assert.equal(created.status, 0, created.stderr);
  assert.match(readFileSync(path.join(fx.etc, "workers", "claude-01.env"), "utf8"), /EXPERT_WORKER_ID=/);
  assert.equal(fx.run(["init", "claude-01"]).status, 1);
  for (const bad of ["../bad", "a/b", "space name"]) {
    assert.notEqual(fx.run(["init", bad]).status, 0, bad);
  }
});

test("manual controller finds a common Node installation when PATH omits node", () => {
  const fx = controllerFixture({ runtimeNode: false });
  assert.equal(fx.run(["init", "claude-01"]).status, 0);
  const json = fx.run(["list", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(
    JSON.parse(json.stdout).map((row: { instance: string }) => row.instance),
    ["claude-01"],
  );
});

test("manual controller lists valid invalid and stale worker instances without leaking secrets", () => {
  // The controller must use its resolved/overridden Node executable rather than
  // invoking a bare "node" from PATH; production WSL/NVM hosts may not expose it.

  const fx = controllerFixture();
  for (const instance of ["claude-01", "codex-01", "broken-01", "stale-01"]) {
    assert.equal(fx.run(["init", instance]).status, 0);
  }
  writeFileSync(
    path.join(fx.etc, "workers", "claude-01.env"),
    "EXPERT_WORKER_ID=ota-claude-01\nEXPERT_EXECUTOR_BACKEND=claude\nEXPERT_CAPABILITY=ota\nEXPERT_RUNTIME_PROFILES=claude-readonly\nEXPERT_WORKER_BOOTSTRAP_TOKEN=super-secret-token\n",
  );
  writeFileSync(
    path.join(fx.etc, "workers", "codex-01.env"),
    "EXPERT_WORKER_ID=ota-codex-01\nEXPERT_EXECUTOR_BACKEND=codex\nEXPERT_CAPABILITY=ota\nEXPERT_RUNTIME_PROFILES=codex-readonly\n",
  );
  writeFileSync(path.join(fx.etc, "workers", "broken-01.env"), "this is not env syntax\n");
  writeFileSync(
    path.join(fx.etc, "workers", "stale-01.env"),
    "EXPERT_WORKER_ID=ota-stale-01\nEXPERT_EXECUTOR_BACKEND=claude\nEXPERT_CAPABILITY=ota\n",
  );
  mkdirSync(path.join(fx.data, "stale-01"), { recursive: true });
  writeFileSync(path.join(fx.data, "stale-01", "worker.pid"), "999999\n");
  writeFileSync(path.join(fx.data, "stale-01", "worker.pid.start"), "1\n");

  const human = fx.run(["list"]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /claude-01\s+ota-claude-01\s+claude\s+ota\s+claude-readonly\s+stopped/);
  assert.match(human.stdout, /codex-01\s+ota-codex-01\s+codex\s+ota\s+codex-readonly\s+stopped/);
  assert.match(human.stdout, /broken-01.*invalid-config/);
  assert.match(human.stdout, /stale-01.*stale-pid/);
  assert.doesNotMatch(human.stdout, /super-secret-token/);

  const json = fx.run(["list", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const rows = JSON.parse(json.stdout) as Array<Record<string, unknown>>;
  assert.deepEqual(
    rows.map((row) => row.instance),
    ["broken-01", "claude-01", "codex-01", "stale-01"],
  );
  assert.equal(rows.find((row) => row.instance === "broken-01")?.status, "invalid-config");
  assert.equal(rows.find((row) => row.instance === "stale-01")?.status, "stale-pid");
  assert.doesNotMatch(json.stdout, /super-secret-token/);
});
