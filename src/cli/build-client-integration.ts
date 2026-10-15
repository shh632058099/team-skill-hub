import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { buildClientIntegrationManifest, loadClientIntegrationRelease } from "../client-integration/release.js";

const execFileAsync = promisify(execFile);

function argument(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function addTreeToZip(zip: JSZip, root: string, current = ""): Promise<void> {
  const abs = path.join(root, current);
  const entries = await readdir(abs, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = path.posix.join(current.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) await addTreeToZip(zip, root, rel);
    else zip.file(rel, await readFile(path.join(root, rel)), { date: new Date("1980-01-01T00:00:00.000Z"), createFolders: false });
  }
}

async function copyAllowedAssets(repoRoot: string, staging: string): Promise<void> {
  const files = [
    "client-integration/release.json",
    "scripts/setup-codex-mcp.sh",
    "scripts/setup-codex-mcp.ps1",
    "scripts/setup-claude-code.sh",
    "scripts/setup-claude-code.ps1",
    "scripts/bootstrap-client-integration.sh",
    "scripts/bootstrap-client-integration.ps1",
    "scripts/team-skill-hub-hook.sh",
    "scripts/team-skill-hub-hook.ps1",
    "scripts/team-skill-hub-claude-stop.sh"
  ];
  for (const rel of files) {
    const source = path.join(repoRoot, rel);
    if (!(await exists(source))) continue;
    const destRel = rel === "client-integration/release.json" ? "release.json" : rel;
    const dest = path.join(staging, destRel);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(source, dest);
  }
  for (const rel of ["client-integration/runtime", "client-integration/updater", "client-integration/templates"]) {
    const source = path.join(repoRoot, rel);
    if (await exists(source)) await cp(source, path.join(staging, path.basename(rel)), { recursive: true });
  }
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const outRoot = path.resolve(argument("--out") ?? path.join(repoRoot, "dist", "client-integration"));
  const release = await loadClientIntegrationRelease(repoRoot);
  const releaseDir = path.join(outRoot, "releases", String(release.version));
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });
  const temp = await mkdtemp(path.join(os.tmpdir(), "team-skill-hub-client-package-"));
  try {
    await copyAllowedAssets(repoRoot, temp);
    const linuxPath = path.join(releaseDir, "linux.tar.gz");
    await execFileAsync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", linuxPath, "-C", temp, "."]);
    const zip = new JSZip();
    await addTreeToZip(zip, temp);
    const windowsPath = path.join(releaseDir, "windows.zip");
    await writeFile(windowsPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    const linuxSha256 = await sha256(linuxPath);
    const windowsSha256 = await sha256(windowsPath);
    const manifest = buildClientIntegrationManifest(release, {
      releasedAt: new Date().toISOString(), serverVersion: "0.1.0", linuxSha256, windowsSha256
    });
    await writeFile(path.join(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await writeFile(path.join(releaseDir, "checksums.json"), JSON.stringify({ linux: linuxSha256, windows: windowsSha256 }, null, 2) + "\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
