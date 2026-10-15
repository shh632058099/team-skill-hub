#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_SESSION_BUDGET_MS = 800;

export function clientRoot() {
  return process.env.TEAM_SKILL_HUB_CLIENT_ROOT || path.join(os.homedir(), ".team-skill-hub");
}

function statePath() { return path.join(clientRoot(), "state.json"); }
function cachePath() { return path.join(clientRoot(), "cache", "manifest.json"); }
function currentPath() { return path.join(clientRoot(), "current"); }
function txPath() { return path.join(clientRoot(), "transactions", "active.json"); }
function lockPath(name) { return path.join(clientRoot(), "locks", name); }

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}

export async function readState() {
  try {
    const value = JSON.parse((await readFile(statePath(), "utf8")).replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || !Number.isInteger(value.schema_version)) throw new Error("invalid state schema");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Unable to read state.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeStateAtomic(state) {
  if (!state || typeof state !== "object") throw new Error("state must be an object");
  const serialized = JSON.stringify(state);
  for (const forbidden of ["api_key", "token", "password", "secret"]) {
    if (Object.keys(state).some((k) => k.toLowerCase() === forbidden)) throw new Error(`state must not contain ${forbidden}`);
  }
  if (/"(?:api_key|token|password|secret)"\s*:/i.test(serialized)) throw new Error("state must not contain secret values");
  await writeJsonAtomic(statePath(), state);
}

export function resolvePackageUrl(relativePath, manifestUrl) {
  const url = new URL(relativePath, manifestUrl);
  const manifestOrigin = new URL(manifestUrl).origin;
  if (url.origin !== manifestOrigin) throw new Error("package URL must use Team Skill Hub origin");
  return url.href;
}

export async function writeManifestCache(manifest, checkedAt = Date.now()) {
  await writeJsonAtomic(cachePath(), { checked_at_ms: checkedAt, manifest });
}

export async function readManifestCache(now = Date.now()) {
  try {
    const value = JSON.parse((await readFile(cachePath(), "utf8")).replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || !value.manifest || !Number.isFinite(value.checked_at_ms)) return null;
    return { manifest: value.manifest, checkedAt: value.checked_at_ms, fresh: now - value.checked_at_ms < CACHE_TTL_MS };
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function acquireLock(name, command, nonBlocking = true) {
  const file = lockPath(name);
  await mkdir(path.dirname(file), { recursive: true });
  const record = { pid: process.pid, created_at: new Date().toISOString(), command };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, "wx", 0o600);
      await handle.writeFile(JSON.stringify(record) + "\n");
      await handle.close();
      let released = false;
      return {
        path: file,
        async release() { if (!released) { released = true; await rm(file, { force: true }); } }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const existing = JSON.parse(await readFile(file, "utf8"));
        stale = !processAlive(Number(existing.pid));
      } catch { stale = true; }
      if (stale) { await rm(file, { force: true }); continue; }
      if (nonBlocking) return null;
      return null;
    }
  }
  return null;
}

export async function acquireUpdateCheckLock() { return acquireLock("update-check.lock", "check-update", true); }
export async function acquireMutationLock(command = "upgrade") { return acquireLock("mutation.lock", command, true); }

export async function writeCurrentVersion(version) {
  await mkdir(clientRoot(), { recursive: true });
  const temp = `${currentPath()}.tmp-${process.pid}`;
  await writeFile(temp, String(version) + "\n");
  await rename(temp, currentPath());
}

export async function readCurrentVersion() {
  try { return Number((await readFile(currentPath(), "utf8")).trim()); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

export async function writeTransaction(journal) { await writeJsonAtomic(txPath(), journal); }
export async function readTransaction() {
  try { return JSON.parse(await readFile(txPath(), "utf8")); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function restoreBackups(backups = []) {
  for (const backup of backups) {
    if (!backup?.path) continue;
    if (backup.existed === false) await rm(backup.path, { force: true, recursive: true });
    else if (backup.backup_path) {
      await mkdir(path.dirname(backup.path), { recursive: true });
      await copyFile(backup.backup_path, backup.path);
    }
  }
}

export async function recoverIncompleteTransaction() {
  const tx = await readTransaction();
  if (!tx || tx.state === "committed") return false;
  if (!["prepared", "applying", "applied"].includes(tx.state)) throw new Error(`Unknown transaction state: ${tx.state}`);
  await restoreBackups(tx.backups);
  if (tx.previous_state) await writeStateAtomic(tx.previous_state);
  if (Number.isInteger(tx.previous_current_version)) await writeCurrentVersion(tx.previous_current_version);
  await rm(txPath(), { force: true });
  if (tx.backup_dir) await rm(tx.backup_dir, { recursive: true, force: true });
  return true;
}

export function decideUpdate(installedVersion, manifest) {
  if (!manifest || !Number.isInteger(manifest.version) || !Number.isInteger(manifest.minimum_supported_version)) return "none";
  if (installedVersion < manifest.minimum_supported_version) return "required_update";
  if (installedVersion < manifest.version) return "optional_update";
  return "none";
}

function validManifest(manifest) {
  return Boolean(manifest && typeof manifest === "object" && Number.isInteger(manifest.version) && manifest.version > 0 && Number.isInteger(manifest.minimum_supported_version) && manifest.minimum_supported_version > 0 && manifest.minimum_supported_version <= manifest.version);
}

async function fetchManifest(manifestUrl, budgetMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(25, budgetMs));
  try {
    const response = await fetch(manifestUrl, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`manifest request failed: ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > 64 * 1024) throw new Error("manifest is too large");
    const text = await response.text();
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("manifest is too large");
    const manifest = JSON.parse(text);
    if (!validManifest(manifest)) throw new Error("invalid manifest");
    return manifest;
  } finally { clearTimeout(timer); }
}

export async function checkUpdateDecision({ installedVersion, manifestUrl, budgetMs = DEFAULT_SESSION_BUDGET_MS }) {
  const cached = await readManifestCache();
  if (cached?.fresh) return { decision: decideUpdate(installedVersion, cached.manifest), manifest: cached.manifest, source: "cache" };
  const lock = await acquireUpdateCheckLock();
  if (!lock) {
    if (cached?.manifest && validManifest(cached.manifest)) return { decision: decideUpdate(installedVersion, cached.manifest), manifest: cached.manifest, source: "stale-cache" };
    return { decision: "none", manifest: null, source: "busy" };
  }
  try {
    const manifest = await fetchManifest(manifestUrl, budgetMs);
    await writeManifestCache(manifest);
    return { decision: decideUpdate(installedVersion, manifest), manifest, source: "network" };
  } catch {
    if (cached?.manifest && validManifest(cached.manifest)) return { decision: decideUpdate(installedVersion, cached.manifest), manifest: cached.manifest, source: "stale-cache" };
    return { decision: "none", manifest: null, source: "error" };
  } finally { await lock.release(); }
}

function managedFilesForState(state) {
  const files = [];
  const codex = state.clients?.codex;
  if (codex?.enabled) {
    for (const name of ["config.toml", "AGENTS.md", "hooks.json"]) files.push(path.join(codex.config_home, name));
    for (const name of ["team-skill-hub-hook.sh", "team-skill-hub-hook.ps1", "team-skill-hub.conf"]) files.push(path.join(codex.config_home, "hooks", name));
  }
  const claude = state.clients?.claude;
  if (claude?.enabled) {
    for (const name of ["settings.json", "CLAUDE.md"]) files.push(path.join(claude.config_home, name));
    for (const name of ["team-skill-hub-claude-stop.sh", "team-skill-hub.conf"]) files.push(path.join(claude.config_home, "hooks", name));
  }
  return files;
}

async function backupManagedFiles(state) {
  const backupDir = path.join(clientRoot(), "transactions", `backup-${Date.now()}-${process.pid}`);
  await mkdir(backupDir, { recursive: true });
  const backups = [];
  let index = 0;
  for (const file of managedFilesForState(state)) {
    const existed = await stat(file).then(() => true, () => false);
    if (!existed) { backups.push({ path: file, existed: false }); continue; }
    const backupPath = path.join(backupDir, String(index++));
    await copyFile(file, backupPath);
    backups.push({ path: file, existed: true, backup_path: backupPath });
  }
  return { backupDir, backups };
}

async function downloadFile(url, file) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`package download failed: ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > 256 * 1024 * 1024) throw new Error("package is too large");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > 256 * 1024 * 1024) throw new Error("package is too large");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buffer);
}

async function extractPackage(archive, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  if (process.platform === "win32") {
    await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`]);
  } else {
    await execFileAsync("tar", ["-xzf", archive, "-C", destination]);
  }
}

async function stageLauncherReplacement(releaseRoot, state) {
  const binDir = path.join(clientRoot(), "bin");
  await mkdir(binDir, { recursive: true });
  for (const name of ["team-skill-hub-client", "team-skill-hub-client.ps1"]) {
    if (process.platform === "win32" && name !== "team-skill-hub-client.ps1") continue;
    const source = path.join(releaseRoot, "runtime", name);
    if (!(await stat(source).then(() => true, () => false))) continue;
    const target = path.join(binDir, name);
    const next = `${target}.next`;
    await copyFile(source, next);
    if (process.platform !== "win32") {
      await rename(next, target);
      if (name === "team-skill-hub-client") await execFileAsync("chmod", ["+x", target]);
    }
  }
  if (process.platform === "win32") state.pending_launcher_version = state.installed_version;
  else delete state.pending_launcher_version;
}

async function clearAppliedPendingLauncherState() {
  const state = await readState();
  if (!state?.pending_launcher_version) return;
  const next = path.join(clientRoot(), "bin", "team-skill-hub-client.ps1.next");
  if (!(await stat(next).then(() => true, () => false))) {
    const updated = { ...state }; delete updated.pending_launcher_version; await writeStateAtomic(updated);
  }
}

export async function upgradeToLatest() {
  const lock = await acquireMutationLock("upgrade");
  if (!lock) throw new Error("another upgrade or rollback is already in progress");
  try {
    await recoverIncompleteTransaction();
    const state = await readState();
    if (!state) throw new Error("Team Skill Hub client integration is not bootstrapped");
    const manifestUrl = new URL("client-integration/manifest.json", `${String(state.hub_base_url).replace(/\/$/, "")}/`).href;
    const manifest = await fetchManifest(manifestUrl, 5000);
    if (state.installed_version >= manifest.version) return { updated: false, version: state.installed_version, restart_required: false };
    const platform = process.platform === "win32" ? "windows" : "linux";
    const pkg = manifest.packages?.[platform];
    if (!pkg?.path || !pkg?.sha256) throw new Error(`manifest has no ${platform} package`);
    const tempArchive = path.join(clientRoot(), "cache", `client-${manifest.version}.${platform === "windows" ? "zip" : "tar.gz"}`);
    await downloadFile(resolvePackageUrl(pkg.path, manifestUrl), tempArchive);
    const actual = await sha256File(tempArchive);
    if (actual !== pkg.sha256) throw new Error("client integration package SHA-256 mismatch");
    const tempRelease = path.join(clientRoot(), "releases", `v${manifest.version}.tmp`);
    await extractPackage(tempArchive, tempRelease);
    const packageRelease = JSON.parse(await readFile(path.join(tempRelease, "release.json"), "utf8"));
    if (Number(packageRelease.version) !== manifest.version) throw new Error("package version does not match manifest");
    const { backupDir, backups } = await backupManagedFiles(state);
    const journal = { state: "prepared", previous_state: structuredClone(state), previous_current_version: state.installed_version, backups, backup_dir: backupDir, from_version: state.installed_version, to_version: manifest.version, target_clients: Object.keys(state.clients || {}) };
    await writeTransaction(journal);
    try {
      await writeTransaction({ ...journal, state: "applying" });
      const updaterFile = path.join(tempRelease, "updater", "updater.mjs");
      const updater = await import(pathToFileURL(updaterFile).href + `?t=${Date.now()}`);
      const targetState = { ...state, previous_version: state.installed_version, installed_version: manifest.version };
      await updater.applyManagedConfig({ clientRoot: clientRoot(), state: targetState, releaseRoot: tempRelease, targetVersion: manifest.version, releaseMetadata: packageRelease });
      await updater.selfCheckManagedConfig({ clientRoot: clientRoot(), state: targetState, releaseRoot: tempRelease, targetVersion: manifest.version, releaseMetadata: packageRelease });
      await writeTransaction({ ...journal, state: "applied" });
      const finalRelease = path.join(clientRoot(), "releases", `v${manifest.version}`);
      await rm(finalRelease, { recursive: true, force: true });
      await rename(tempRelease, finalRelease);
      await stageLauncherReplacement(finalRelease, targetState);
      await writeCurrentVersion(manifest.version);
      await writeStateAtomic({ ...targetState, last_successful_upgrade_at: new Date().toISOString() });
      await writeTransaction({ ...journal, state: "committed" });
      await rm(txPath(), { force: true });
      await rm(backupDir, { recursive: true, force: true });
      return { updated: true, version: manifest.version, restart_required: Boolean(manifest.restart_required) };
    } catch (error) {
      await recoverIncompleteTransaction();
      throw error;
    } finally {
      await rm(tempArchive, { force: true });
    }
  } finally { await lock.release(); }
}

export async function rollbackToPrevious() {
  const lock = await acquireMutationLock("rollback");
  if (!lock) throw new Error("another upgrade or rollback is already in progress");
  try {
    await recoverIncompleteTransaction();
    const state = await readState();
    if (!state || !Number.isInteger(state.previous_version)) throw new Error("no previous client integration version is available");
    const target = state.previous_version;
    const releaseRoot = path.join(clientRoot(), "releases", `v${target}`);
    const updaterFile = path.join(releaseRoot, "updater", "updater.mjs");
    if (!(await stat(updaterFile).then(() => true, () => false))) throw new Error(`previous release v${target} is not available locally`);
    const { backupDir, backups } = await backupManagedFiles(state);
    const journal = { state: "applying", previous_state: structuredClone(state), previous_current_version: state.installed_version, backups, backup_dir: backupDir, from_version: state.installed_version, to_version: target, kind: "rollback" };
    await writeTransaction(journal);
    try {
      const updater = await import(pathToFileURL(updaterFile).href + `?t=${Date.now()}`);
      const targetState = { ...state, installed_version: target, previous_version: state.installed_version };
      await updater.reconcileToVersion({ clientRoot: clientRoot(), state: targetState, releaseRoot, targetVersion: target });
      await stageLauncherReplacement(releaseRoot, targetState);
      await writeCurrentVersion(target);
      await writeStateAtomic(targetState);
      await writeTransaction({ ...journal, state: "committed" });
      await rm(txPath(), { force: true });
      await rm(backupDir, { recursive: true, force: true });
    } catch (error) {
      await recoverIncompleteTransaction();
      throw error;
    }
  } finally { await lock.release(); }
}
export async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function main() {
  await recoverIncompleteTransaction();
  await clearAppliedPendingLauncherState();
  const command = process.argv[2] || "version";
  if (command === "version") {
    const state = await readState();
    process.stdout.write(`${state?.installed_version ?? 0}\n`);
    return;
  }
  if (command === "doctor") {
    const state = await readState();
    process.stdout.write(JSON.stringify({ ok: Boolean(state), installed_version: state?.installed_version ?? null, clients: state?.clients ?? {} }, null, 2) + "\n");
    return;
  }
  if (command === "upgrade") {
    const result = await upgradeToLatest();
    process.stdout.write(result.updated ? `Upgraded Team Skill Hub client integration to v${result.version}.${result.restart_required ? " Restart the CLI." : ""}\n` : `Team Skill Hub client integration is already current (v${result.version}).\n`);
    return;
  }
  if (command === "rollback") {
    await rollbackToPrevious();
    const state = await readState();
    process.stdout.write(`Rolled back Team Skill Hub client integration to v${state?.installed_version}. Restart the CLI.\n`);
    return;
  }
  if (command === "lifecycle") return;
  if (command === "check-update" || command === "session-start") {
    const state = await readState();
    if (!state) return;
    const manifestUrl = new URL("client-integration/manifest.json", `${String(state.hub_base_url).replace(/\/$/, "")}/`).href;
    const result = await checkUpdateDecision({ installedVersion: state.installed_version, manifestUrl });
    if (command === "check-update") {
      process.stdout.write(JSON.stringify(result) + "\n");
      return;
    }
    const clientIndex = process.argv.indexOf("--client");
    const client = clientIndex >= 0 ? process.argv[clientIndex + 1] : "codex";
    const detail = { installed: state.installed_version, latest: result.manifest?.version ?? state.installed_version, minimum: result.manifest?.minimum_supported_version ?? state.installed_version };
    const renderer = client === "claude" ? await import("./render-claude.mjs") : await import("./render-codex.mjs");
    const output = client === "claude" ? renderer.renderClaudeDecision(result.decision, detail) : renderer.renderCodexDecision(result.decision, detail);
    if (output) process.stdout.write(output + (output.endsWith("\n") ? "" : "\n"));
    return;
  }
  throw new Error(`Unsupported command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
