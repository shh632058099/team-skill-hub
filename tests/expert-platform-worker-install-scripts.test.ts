import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  assert.match(manual, /RUNUSER=/);
  assert.match(manual, /\/usr\/sbin\/runuser/);
  assert.match(manual, /\/sbin\/runuser/);
  assert.match(manual, /"\$RUNUSER" --user expert-worker --preserve-environment/);
  assert.match(manual, /USER_MODE/);
  assert.match(manual, /DEFAULT_ETC/);
  assert.match(manual, /DEFAULT_DATA/);
  assert.match(manual, /if \[\[ \$USER_MODE -eq 1 \]\]; then/);
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
    /ExecStart="\/opt\/team-skill-hub-worker\/node" .*\/opt\/team-skill-hub-worker\/current\/src\/cli\/expert-worker\.js/,
  );
  assert.match(
    service,
    /^ExecStart="\/opt\/team-skill-hub-worker\/node" "\/opt\/team-skill-hub-worker\/current\/src\/cli\/expert-worker\.js"$/m,
  );
  assert.match(service, /^Restart=always$/m);
  assert.doesNotMatch(service, /expert-worker\.jsRestart=/);
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

test("installer accepts a custom install directory and explicit no-systemd mode", () => {
  const installer = readFileSync(new URL("install-worker.sh", runtime), "utf8");
  assert.match(installer, /--install-dir/);
  assert.match(installer, /--no-systemd/);
  assert.match(installer, /docker info/);
  assert.match(installer, /invoking user's PATH precedence/);
  assert.match(installer, /export PATH="\$\{PATH:-\}:\/usr\/sbin/);
  assert.match(installer, /WORKER_RUNTIME_DOCKER/);
  assert.match(installer, /USER_MODE|unprivileged user mode/);
  assert.match(installer, /\$BASE\/\.worker-runtime-mode/);
  assert.match(installer, /BASE=\$\(cd \"\$INSTALL_DIR\" && pwd -P\)/);
  assert.match(installer, /NO_SYSTEMD -eq 0/);
  assert.match(installer, /if \[\[ \$NO_SYSTEMD -eq 0 && -e \"\$LEGACY_UNIT\" \]\]/);
  assert.match(installer, /sed .*team-skill-hub-worker@\.service/);
  assert.match(installer, /touch \"\$BASE\/\.no-systemd\"/);
  assert.match(installer, /Install directory cannot contain double quotes/);
  assert.match(installer, /systemctl daemon-reload/);
  const control = readFileSync(new URL("worker-control.sh", runtime), "utf8");
  assert.match(control, /SCRIPT_PATH=\$\(readlink -f/);
  assert.match(control, /HOST_ROOT\/\.no-systemd/);
  assert.match(installer, /worker-control\.sh.*init/);
});

test("worker control derives runtime and bundled Node from its installed location, independent of cwd", () => {
  const root = mkdtempSync(path.join(tmpdir(), "skillhub-worker-custom install "));
  const release = path.join(root, "releases", "0.1.0");
  const etc = path.join(root, "etc");
  const data = path.join(root, "data");
  mkdirSync(release, { recursive: true });
  mkdirSync(etc, { recursive: true });
  mkdirSync(data, { recursive: true });
  copyFileSync(new URL("worker-control.sh", runtime), path.join(release, "worker-control.sh"));
  copyFileSync(new URL("worker.env.example", runtime), path.join(etc, "worker.env.example"));
  mkdirSync(path.join(release, "src", "cli"), { recursive: true });
  writeFileSync(path.join(release, "src", "cli", "expert-worker.js"), "");
  writeFileSync(path.join(release, "check-worker-config.js"), "");
  const node = path.join(root, "node");
  symlinkSync(process.execPath, node);
  symlinkSync(release, path.join(root, "current"));
  const result = spawnSync("bash", [path.join(root, "current", "worker-control.sh"), "init", "custom-01"], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      WORKER_RUNTIME_ETC_ROOT: etc,
      WORKER_RUNTIME_DATA_ROOT: data,
      WORKER_RUNTIME_SKIP_ROOT_CHECK: "1",
      PATH: "/usr/bin:/bin",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(etc, "workers", "custom-01.env")), true);
  const inventory = spawnSync("bash", [path.join(root, "current", "worker-control.sh"), "list", "--json"], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      WORKER_RUNTIME_ETC_ROOT: etc,
      WORKER_RUNTIME_DATA_ROOT: data,
      WORKER_RUNTIME_SKIP_ROOT_CHECK: "1",
      PATH: "/usr/bin:/bin",
    },
    encoding: "utf8",
  });
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.equal(JSON.parse(inventory.stdout)[0].instance, "custom-01");
});

test("unprivileged user mode keeps config and data under install dir and does not require root tools", () => {
  const installer = readFileSync(new URL("install-worker.sh", runtime), "utf8");
  const control = readFileSync(new URL("worker-control.sh", runtime), "utf8");
  assert.match(installer, /if \[\[ \$EUID -ne 0 \]\]; then/);
  assert.match(installer, /ETC="\$BASE\/etc\/team-skill-hub-worker"/);
  assert.match(installer, /DATA="\$BASE\/data"/);
  assert.match(installer, /The installer will not modify system group membership/);
  assert.doesNotMatch(
    installer.slice(
      installer.indexOf("# Non-root + --no-systemd"),
      installer.indexOf("ETC=/etc/team-skill-hub-worker"),
    ),
    /groupadd|useradd|usermod|chown|runuser|systemctl/,
  );
  assert.match(control, /if \[\[ \$USER_MODE -eq 0 .*EUID -ne 0/);
  assert.match(control, /if \[\[ \$USER_MODE -eq 1 \]\]; then/);
  assert.match(control, /\$NODE" "\$WORKER_SCRIPT"/);
});

test("non-root user can install, initialize, start, inspect and stop Worker without system paths", (t) => {
  if (process.getuid?.() !== 0) {
    t.skip("integration test uses setpriv to exercise an actual non-root identity");
    return;
  }
  let dockerGid = "";
  try {
    dockerGid = execFileSync("getent", ["group", "docker"], { encoding: "utf8" }).trim().split(":")[2] ?? "";
    execFileSync("setpriv", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("setpriv or docker group is unavailable");
    return;
  }
  const root = mkdtempSync(path.join(tmpdir(), "skillhub-worker-user-mode-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bootstrap = path.join(root, "bootstrap");
  const payload = path.join(root, "payload");
  const home = path.join(root, "home");
  const mockbin = path.join(root, "mockbin");
  const installDir = path.join(home, "team-skill-hub-worker");
  mkdirSync(bootstrap);
  mkdirSync(path.join(payload, "src", "cli"), { recursive: true });
  mkdirSync(home);
  mkdirSync(mockbin);
  for (const directory of [
    root,
    bootstrap,
    payload,
    path.join(payload, "src"),
    path.join(payload, "src", "cli"),
    home,
    mockbin,
  ]) {
    chmodSync(directory, 0o755);
  }
  for (const file of ["worker-control.sh", "worker.env.example", "check-worker-config.js"]) {
    copyFileSync(new URL(file, runtime), path.join(payload, file));
  }
  writeFileSync(path.join(payload, "src", "cli", "expert-worker.js"), "// fixture worker\n");
  const mockNode = path.join(mockbin, "node");
  writeFileSync(
    mockNode,
    "#!/usr/bin/env bash\n" +
      'if [[ "${1:-}" == "--version" ]]; then echo v24.19.0; exit 0; fi\n' +
      'if [[ "${1:-}" == "-e" ]]; then printf \'{"instance":"%s"}\\n\' "${INSTANCE_JSON:-fixture}"; exit 0; fi\n' +
      'if [[ "${1:-}" == */check-worker-config.js ]]; then echo config-ok; exit 0; fi\n' +
      'if [[ "${1:-}" == */expert-worker.js ]]; then while :; do sleep 1; done; fi\n' +
      "exit 0\n",
  );
  writeFileSync(path.join(mockbin, "docker"), '#!/usr/bin/env bash\n[[ "$1" == info ]]\n');
  chmodSync(mockNode, 0o755);
  chmodSync(path.join(mockbin, "docker"), 0o755);
  const archive = path.join(bootstrap, "worker-runtime-9.9.9.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", payload, "."]);
  const bootstrapInstaller = path.join(bootstrap, "install-worker.sh");
  copyFileSync(new URL("install-worker.sh", runtime), bootstrapInstaller);
  chmodSync(bootstrapInstaller, 0o755);
  execFileSync("chown", ["-R", "65534:65534", home]);

  const asUser = (args: string[]) =>
    spawnSync(
      "setpriv",
      [
        "--reuid=65534",
        "--regid=65534",
        `--groups=${dockerGid}`,
        "env",
        `HOME=${home}`,
        `PATH=${mockbin}:/usr/bin:/bin`,
        `WORKER_RUNTIME_NODE=${mockNode}`,
        `WORKER_RUNTIME_DOCKER=${path.join(mockbin, "docker")}`,
        "bash",
        ...args,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
  const installed = asUser([bootstrapInstaller, archive, "--install-dir", installDir, "--no-systemd"]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(readFileSync(path.join(installDir, ".worker-runtime-mode"), "utf8").trim(), "user");
  assert.equal(existsSync(path.join(installDir, "etc", "team-skill-hub-worker", "workers")), true);

  const control = path.join(installDir, "current", "worker-control.sh");
  const rootInvocation = spawnSync("bash", [control, "list"], { encoding: "utf8" });
  assert.notEqual(rootInvocation.status, 0);
  assert.match(rootInvocation.stderr, /do not run worker-control\.sh with sudo\/root/);
  const initialized = asUser([control, "init", "test-01"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  const started = asUser([control, "test-01", "start"]);
  assert.equal(started.status, 0, started.stderr);
  const status = asUser([control, "test-01", "status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /running/);
  const stopped = asUser([control, "test-01", "stop"]);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /stopped/);
  const data = path.join(installDir, "data", "test-01");
  assert.equal(existsSync(path.join(data, "worker.log")), true);
});

test("user-mode controller derives etc template from install root, not a stale etc marker", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "skillhub-worker-user-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = path.join(root, "releases", "0.2.0");
  const etc = path.join(root, "etc", "team-skill-hub-worker");
  mkdirSync(path.join(release, "src", "cli"), { recursive: true });
  mkdirSync(path.join(etc, "workers"), { recursive: true });
  mkdirSync(path.join(root, "data"), { recursive: true });
  copyFileSync(new URL("worker-control.sh", runtime), path.join(release, "worker-control.sh"));
  copyFileSync(new URL("worker.env.example", runtime), path.join(etc, "worker.env.example"));
  writeFileSync(path.join(release, "src", "cli", "expert-worker.js"), "");
  writeFileSync(path.join(release, "check-worker-config.js"), "");
  symlinkSync(release, path.join(root, "current"));
  writeFileSync(path.join(root, ".worker-runtime-mode"), "user\n");
  // Simulate an older/bad installer that stored only the install root in this marker.
  writeFileSync(path.join(root, ".worker-runtime-etc"), `${root}\n`);
  writeFileSync(path.join(root, ".worker-runtime-data"), `${root}\n`);
  if (process.getuid?.() === 0) execFileSync("chown", ["-R", "65534:65534", root]);
  const args = ["bash", path.join(root, "current", "worker-control.sh"), "init", "user-01"];
  const result =
    process.getuid?.() === 0
      ? spawnSync(
          "setpriv",
          [
            "--reuid=65534",
            "--regid=65534",
            "--clear-groups",
            "env",
            "PATH=/usr/bin:/bin",
            "WORKER_RUNTIME_SKIP_ROOT_CHECK=1",
            ...args,
          ],
          { cwd: tmpdir(), encoding: "utf8" },
        )
      : spawnSync(args[0]!, args.slice(1), {
          cwd: tmpdir(),
          env: { ...process.env, WORKER_RUNTIME_SKIP_ROOT_CHECK: "1", PATH: "/usr/bin:/bin" },
          encoding: "utf8",
        });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(etc, "workers", "user-01.env")), true);
});
