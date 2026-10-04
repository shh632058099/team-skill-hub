import { readFile, stat } from "node:fs/promises";
import path from "node:path";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function assertSemver(value: string, label: string): void {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (!semver.test(value)) throw new Error(label + " is not a valid semantic version: " + value);
}

async function main(): Promise<void> {
  const root = process.cwd();
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  if (!packageJson.version) throw new Error("package.json version is missing");
  assertSemver(packageJson.version, "package.json version");

  const tag = argument("--tag") ?? process.env.RELEASE_TAG;
  if (tag) {
    if (!/^v\d/.test(tag)) throw new Error("release tag must start with v: " + tag);
    const tagVersion = tag.slice(1);
    assertSemver(tagVersion, "release tag");
    if (tagVersion !== packageJson.version) {
      throw new Error("release tag " + tag + " does not match package.json version " + packageJson.version);
    }
  }

  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  if (!changelog.includes("## [" + packageJson.version + "]")) {
    throw new Error("CHANGELOG.md has no section for " + packageJson.version);
  }

  const migrationPath = path.join(root, "docs", "migrations", packageJson.version + ".md");
  await stat(migrationPath).catch(() => {
    throw new Error("migration note is missing: docs/migrations/" + packageJson.version + ".md");
  });

  const workflow = await readFile(path.join(root, ".github", "workflows", "docker-image.yml"), "utf8");
  if (!workflow.includes("type=ref,event=tag")) {
    throw new Error("docker workflow does not publish immutable tag references");
  }
  if (!workflow.includes("type=sha")) {
    throw new Error("docker workflow does not publish immutable SHA references");
  }

  console.log(JSON.stringify({
    ok: true,
    package: packageJson.name,
    version: packageJson.version,
    tag: tag ?? null,
    changelog: "CHANGELOG.md",
    migrationNote: path.relative(root, migrationPath).replaceAll("\\", "/"),
    immutableImageTags: ["git-tag", "git-sha"]
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
