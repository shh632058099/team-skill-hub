import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

export interface DataBackupFile {
  path: string;
  size: number;
  sha256: string;
}

export interface DataBackupManifest {
  schemaVersion: 1;
  createdAt: string;
  files: DataBackupFile[];
}

export interface RestoreResult {
  restoredFiles: number;
  previousDataDir?: string;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

function nativePath(value: string): string {
  return value.split("/").join(path.sep);
}

async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("Backup refuses symbolic links: " + portablePath(path.relative(root, absolute)));
    }
    if (entry.isDirectory()) {
      result.push(...await walkFiles(root, absolute));
    } else if (entry.isFile()) {
      result.push(absolute);
    }
  }
  return result;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function directoryHasEntries(target: string): Promise<boolean> {
  try {
    return (await readdir(target)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function createDataBackup(dataDir: string, destination: string): Promise<DataBackupManifest> {
  const source = path.resolve(dataDir);
  const output = path.resolve(destination);
  if (isPathInside(source, output)) {
    throw new Error("Backup destination must be outside DATA_DIR");
  }
  if (await pathExists(output)) {
    throw new Error("Backup destination already exists");
  }

  const parent = path.dirname(output);
  const temp = path.join(parent, "." + path.basename(output) + ".tmp-" + randomUUID());
  await mkdir(path.join(temp, "data"), { recursive: true });
  try {
    const files = await walkFiles(source);
    const manifestFiles: DataBackupFile[] = [];
    for (const absolute of files) {
      const relative = portablePath(path.relative(source, absolute));
      const destinationFile = path.join(temp, "data", nativePath(relative));
      await mkdir(path.dirname(destinationFile), { recursive: true });
      await copyFile(absolute, destinationFile);
      const info = await stat(absolute);
      manifestFiles.push({
        path: relative,
        size: info.size,
        sha256: await sha256File(destinationFile)
      });
    }
    manifestFiles.sort((a, b) => a.path.localeCompare(b.path));
    const manifest: DataBackupManifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      files: manifestFiles
    };
    await writeFile(
      path.join(temp, "backup-manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 }
    );
    await rename(temp, output);
    return manifest;
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function verifyDataBackup(backupDir: string): Promise<DataBackupManifest> {
  const root = path.resolve(backupDir);
  const manifestPath = path.join(root, "backup-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as DataBackupManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error("Unsupported or invalid backup manifest");
  }
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!file.path || file.path.startsWith("/") || file.path.includes("..") || seen.has(file.path)) {
      throw new Error("Invalid backup manifest path: " + file.path);
    }
    seen.add(file.path);
    const absolute = path.resolve(root, "data", nativePath(file.path));
    const dataRoot = path.resolve(root, "data");
    if (!isPathInside(dataRoot, absolute)) throw new Error("Backup path escapes data directory");
    const info = await stat(absolute);
    if (!info.isFile() || info.size !== file.size) {
      throw new Error("Backup file size mismatch: " + file.path);
    }
    const digest = await sha256File(absolute);
    if (digest !== file.sha256) {
      throw new Error("Backup checksum mismatch: " + file.path);
    }
  }
  return manifest;
}

export async function restoreDataBackup(
  backupDir: string,
  dataDir: string,
  options?: { force?: boolean; verifyOnly?: boolean }
): Promise<RestoreResult> {
  const manifest = await verifyDataBackup(backupDir);
  if (options?.verifyOnly) return { restoredFiles: manifest.files.length };

  const backupRoot = path.resolve(backupDir);
  const target = path.resolve(dataDir);
  if (isPathInside(target, backupRoot)) {
    throw new Error("Backup source must be outside target DATA_DIR");
  }
  const targetExists = await pathExists(target);
  const targetHasEntries = targetExists && await directoryHasEntries(target);
  if (targetHasEntries && !options?.force) {
    throw new Error("Target DATA_DIR is not empty; pass --force to preserve and replace it");
  }

  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const temp = path.join(parent, "." + path.basename(target) + ".restore-" + randomUUID());
  await mkdir(temp, { recursive: true });
  try {
    for (const file of manifest.files) {
      const source = path.join(backupRoot, "data", nativePath(file.path));
      const destination = path.join(temp, nativePath(file.path));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      if (await sha256File(destination) !== file.sha256) {
        throw new Error("Restored file checksum mismatch: " + file.path);
      }
    }

    let previousDataDir: string | undefined;
    if (targetExists) {
      previousDataDir = target + ".pre-restore-" + new Date().toISOString().replace(/[:.]/g, "-");
      await rename(target, previousDataDir);
    }
    try {
      await rename(temp, target);
    } catch (error) {
      if (previousDataDir) await rename(previousDataDir, target).catch(() => undefined);
      throw error;
    }
    return { restoredFiles: manifest.files.length, previousDataDir };
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
