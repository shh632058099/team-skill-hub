import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const runtime = new URL("../worker-runtime/", import.meta.url);
const packageScript = readFileSync(new URL("../scripts/package-worker-runtime.mjs", import.meta.url), "utf8");

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
