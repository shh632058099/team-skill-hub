import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { runReadOnlyDiagnostic } from "../src/expert-platform/diagnostic-executor.js";

test("diagnostic executor uses an allowlisted operation and returns bounded output", async () => {
  const result = await runReadOnlyDiagnostic({ sourcePath: path.resolve("."), operation: "node-version" });
  assert.match(result, /^v24\./);
});
test("diagnostic executor rejects unsupported operations", async () => {
  await assert.rejects(
    () => runReadOnlyDiagnostic({ sourcePath: path.resolve("."), operation: "shell" as "node-version" }),
    /INVALID_DIAGNOSTIC/,
  );
});
