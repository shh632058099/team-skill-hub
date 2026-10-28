import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "dist-worker", "src");
if (!existsSync(path.join(source, "cli", "expert-worker.js"))) {
  throw new Error("WORKER_RUNTIME_NOT_BUILT: run tsc -p tsconfig.worker.json first");
}
const metadata = JSON.parse(readFileSync(path.join(root, "worker-runtime", "package.json"), "utf8"));
const artifacts = path.join(root, "artifacts", "worker-runtime");
const stage = path.join(artifacts, `worker-runtime-${metadata.version}`);
const archive = path.join(artifacts, `worker-runtime-${metadata.version}.tar.gz`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(source, path.join(stage, "src"), { recursive: true });
mkdirSync(path.join(stage, "src", "expert-platform", "proto"), { recursive: true });
cpSync(
  path.join(root, "src", "expert-platform", "proto", "expert-worker.proto"),
  path.join(stage, "src", "expert-platform", "proto", "expert-worker.proto"),
);
for (const file of [
  "package.json",
  "package-lock.json",
  "worker.env.example",
  "team-skill-hub-worker.service",
  "install-worker.sh",
  "worker-control.sh",
  "README.md",
  "check-worker-config.js",
]) {
  cpSync(path.join(root, "worker-runtime", file), path.join(stage, file));
}
chmodSync(path.join(stage, "install-worker.sh"), 0o755);
chmodSync(path.join(stage, "worker-control.sh"), 0o755);
chmodSync(path.join(stage, "check-worker-config.js"), 0o755);
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: stage,
  stdio: "inherit",
});
rmSync(archive, { force: true });
execFileSync("tar", ["-czf", archive, "-C", stage, "."], { stdio: "inherit" });
console.log(
  JSON.stringify(
    { artifact: path.relative(root, archive), version: metadata.version, includesHubSource: false },
    null,
    2,
  ),
);
