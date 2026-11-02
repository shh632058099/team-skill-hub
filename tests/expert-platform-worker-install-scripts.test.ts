import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const runtime = new URL("../worker-runtime/", import.meta.url);
const packageScript = readFileSync(new URL("../scripts/package-worker-runtime.mjs", import.meta.url), "utf8");

function controllerFixture() {
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

test("installer only registers service when systemd is running and manual script drops privileges", () => {
  const installer = readFileSync(new URL("install-worker.sh", runtime), "utf8");
  const manual = readFileSync(new URL("worker-control.sh", runtime), "utf8");
  assert.match(installer, /\/run\/systemd\/system/);
  assert.match(installer, /systemctl show-environment/);
  assert.match(installer, /worker-control\.sh start/);
  assert.match(manual, /runuser --user expert-worker --preserve-environment/);
  assert.match(manual, /worker_start_time/);
  assert.match(manual, /worker\.log/);
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

test("manual controller lists valid invalid and stale worker instances without leaking secrets", () => {
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
