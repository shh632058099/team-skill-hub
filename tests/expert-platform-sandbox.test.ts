import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { buildReadOnlySandboxArgs } from "../src/expert-platform/sandbox.js";

test("sandbox has isolated readonly source, memory and process limits", () => {
  const args = buildReadOnlySandboxArgs({
    image: "node:24-bookworm-slim",
    sourcePath: path.resolve("fixtures"),
    command: ["node", "--version"],
  });
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("none"));
  assert.ok(args.includes("ALL"));
  assert.ok(args.includes("no-new-privileges"));
  assert.ok(args.includes("65534:65534"));
  assert.ok(args.includes("type=tmpfs,dst=/tmp,tmpfs-size=16777216"));
  assert.ok(args.some((arg) => arg.includes("dst=/source,readonly")));
  assert.equal(args.at(-2), "node");
  assert.equal(args.at(-1), "--version");
});
test("sandbox rejects relative paths and empty commands", () => {
  assert.throws(
    () => buildReadOnlySandboxArgs({ image: "node:24-bookworm-slim", sourcePath: ".", command: ["true"] }),
    /INVALID_SOURCE_PATH/,
  );
  assert.throws(
    () => buildReadOnlySandboxArgs({ image: "node:24-bookworm-slim", sourcePath: "/tmp", command: [] }),
    /INVALID_COMMAND/,
  );
});
