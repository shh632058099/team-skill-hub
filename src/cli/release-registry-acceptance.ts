import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { validateRegistryRelease } from "../release-registry-acceptance.js";

const execFileAsync = promisify(execFile);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = argument(name)?.trim();
  if (!value) throw new Error(name + " is required");
  return value;
}

async function main(): Promise<void> {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
  const dockerExecutable = argument("--docker") ?? "docker";
  const expectedVersion = argument("--expected-version") ?? packageJson.version;
  const report = await validateRegistryRelease(
    {
      releaseImage: required("--release-image"),
      shaImage: required("--sha-image"),
      rollbackImage: required("--rollback-image"),
      expectedVersion
    },
    {
      async run(args: string[]): Promise<string> {
        const result = await execFileAsync(dockerExecutable, args, {
          cwd: process.cwd(),
          env: process.env,
          maxBuffer: 4 * 1024 * 1024
        });
        return result.stdout;
      }
    }
  );
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
