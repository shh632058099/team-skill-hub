import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function requiresClientVersionBump(paths: string[]): boolean {
  return paths.some((file) => {
    if (file === "client-integration/release.json") return false;
    return (
      file.startsWith("client-integration/") ||
      /^scripts\/setup-(?:codex|claude)-/.test(file) ||
      /^scripts\/team-skill-hub-(?:hook|claude-stop)/.test(file) ||
      /^scripts\/bootstrap-client-integration\./.test(file)
    );
  });
}

type ClientReleaseMetadata = Record<string, unknown> & { version?: number; minimumSupportedVersion?: number };

export function releaseMetadataRequiresClientVersionBump(
  before: ClientReleaseMetadata,
  after: ClientReleaseMetadata,
): boolean {
  const normalize = (value: ClientReleaseMetadata) =>
    Object.entries(value)
      .filter(([key]) => key !== "version" && key !== "minimumSupportedVersion")
      .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(normalize(before)) !== JSON.stringify(normalize(after));
}

async function git(args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd: process.cwd(), encoding: "utf8" })).stdout.trim();
}

async function currentRelease(): Promise<ClientReleaseMetadata> {
  const release = JSON.parse(await readFile("client-integration/release.json", "utf8")) as ClientReleaseMetadata;
  if (!Number.isInteger(release.version)) throw new Error("client-integration/release.json version is invalid");
  return release;
}

async function baseRelease(base: string): Promise<ClientReleaseMetadata | null> {
  try {
    return JSON.parse(await git(["show", `${base}:client-integration/release.json`])) as ClientReleaseMetadata;
  } catch {
    return null;
  }
}
async function main(): Promise<void> {
  const base = argument("--base") ?? process.env.CLIENT_INTEGRATION_BASE_REF ?? "HEAD^";
  let changed: string[];
  try {
    changed = (await git(["diff", "--name-only", `${base}...HEAD`])).split("\n").filter(Boolean);
  } catch {
    changed = (await git(["diff", "--name-only", base, "HEAD"])).split("\n").filter(Boolean);
  }
  const before = await baseRelease(base);
  const after = await currentRelease();
  const releaseChanged = changed.includes("client-integration/release.json");
  const metadataNeedsBump = Boolean(
    before && releaseChanged && releaseMetadataRequiresClientVersionBump(before, after),
  );
  const sourceNeedsBump = requiresClientVersionBump(changed);
  if (!sourceNeedsBump && !metadataNeedsBump) {
    console.log(JSON.stringify({ ok: true, base, clientOwnedChanges: false }));
    return;
  }
  if (before === null) {
    console.log(JSON.stringify({ ok: true, base, bootstrapRelease: true, version: after.version }));
    return;
  }
  const beforeVersion = Number(before.version);
  const afterVersion = Number(after.version);
  if (beforeVersion === afterVersion)
    throw new Error(`client integration sources or release metadata changed but version remained ${afterVersion}`);
  if (afterVersion < beforeVersion)
    throw new Error(`client integration version regressed from ${beforeVersion} to ${afterVersion}`);
  console.log(JSON.stringify({ ok: true, base, previousVersion: beforeVersion, version: afterVersion }));
}

if (
  process.argv[1]?.endsWith("client-integration-version-check.ts") ||
  process.argv[1]?.endsWith("client-integration-version-check.js")
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
