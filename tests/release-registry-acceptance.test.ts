import assert from "node:assert/strict";
import test from "node:test";
import { validateRegistryRelease, type DockerCommandRunner } from "../src/release-registry-acceptance.js";

class FakeDocker implements DockerCommandRunner {
  readonly calls: string[][] = [];
  constructor(private readonly ids: Record<string, string>) {}

  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    if (args[0] === "pull") return "pulled\n";
    if (args[0] === "image" && args[1] === "inspect" && args[3] === "{{.Id}}") {
      return this.ids[args[4]!] + "\n";
    }
    if (args[0] === "image" && args[1] === "inspect" && args[3] === "{{json .RepoDigests}}") {
      const image = args[4]!;
      return JSON.stringify([image.split(":")[0] + "@sha256:" + (image.includes("rollback") ? "b" : "a").repeat(64)]) + "\n";
    }
    if (args[0] === "run") return "0.1.0\n";
    throw new Error("Unexpected fake docker call: " + args.join(" "));
  }
}

test("release registry acceptance verifies version/SHA identity, digests and rollback availability", async () => {
  const release = "ghcr.io/example/team-skill-hub:v0.1.0";
  const sha = "ghcr.io/example/team-skill-hub:sha-abcdef1";
  const rollback = "ghcr.io/example/team-skill-hub:rollback-v0.0.9";
  const docker = new FakeDocker({
    [release]: "sha256:" + "1".repeat(64),
    [sha]: "sha256:" + "1".repeat(64),
    [rollback]: "sha256:" + "2".repeat(64)
  });

  const report = await validateRegistryRelease({
    releaseImage: release,
    shaImage: sha,
    rollbackImage: rollback,
    expectedVersion: "0.1.0"
  }, docker);

  assert.equal(report.ok, true);
  assert.equal(report.releaseImageId, report.shaImageId);
  assert.equal(report.imageVersion, "0.1.0");
  assert.equal(report.rollbackImageId, "sha256:" + "2".repeat(64));
  assert.ok(report.releaseDigests[0]?.includes("@sha256:"));
  assert.deepEqual(docker.calls.slice(0, 3), [["pull", release], ["pull", sha], ["pull", rollback]]);
});

test("release registry acceptance rejects tag/SHA mismatch and latest references", async () => {
  const docker = new FakeDocker({
    "ghcr.io/example/hub:v0.1.0": "sha256:" + "1".repeat(64),
    "ghcr.io/example/hub:sha-deadbee": "sha256:" + "2".repeat(64),
    "ghcr.io/example/hub:v0.0.9": "sha256:" + "3".repeat(64)
  });
  await assert.rejects(
    () => validateRegistryRelease({
      releaseImage: "ghcr.io/example/hub:v0.1.0",
      shaImage: "ghcr.io/example/hub:sha-deadbee",
      rollbackImage: "ghcr.io/example/hub:v0.0.9",
      expectedVersion: "0.1.0"
    }, docker),
    /do not resolve to the same built image/
  );
  await assert.rejects(
    () => validateRegistryRelease({
      releaseImage: "ghcr.io/example/hub:latest",
      shaImage: "ghcr.io/example/hub:sha-deadbee",
      rollbackImage: "ghcr.io/example/hub:v0.0.9",
      expectedVersion: "0.1.0"
    }, docker),
    /must be an immutable tag or digest reference/
  );
});
