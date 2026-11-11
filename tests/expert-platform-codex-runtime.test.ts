import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCodexArgs, buildCodexReadOnlyArgs, parseCodexJsonlResult } from "../src/expert-platform/codex-runtime.js";

test("Codex invocation enforces read-only sandbox and ephemeral JSON output", () => {
  const args = buildCodexReadOnlyArgs("Investigate OTA");
  assert.deepEqual(args.slice(0, 5), ["exec", "--sandbox", "read-only", "--ephemeral", "--json"]);
  assert.equal(args.at(-1), "Investigate OTA");
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
});
test("Codex result requires successful turn and bounded assistant content", () => {
  const stream = [
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Likely OTA state mismatch" } }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ].join("\n");
  assert.equal(parseCodexJsonlResult(stream), "Likely OTA state mismatch");
  assert.throws(() => parseCodexJsonlResult(stream.replace("turn.completed", "turn.failed")), /CODEX_TURN_FAILED/);
  assert.throws(() => parseCodexJsonlResult("{}"), /CODEX_RESULT_MISSING/);
});

test("Codex invocation uses workspace-write sandbox only for write policy", () => {
  const args = buildCodexArgs("Modify fixture", "workspace-write");
  assert.deepEqual(args.slice(0, 5), ["exec", "--sandbox", "workspace-write", "--ephemeral", "--json"]);
  assert.ok(!args.includes("danger-full-access"));
});

test("Codex Work session persists initially and resumes with the same sandbox policy", () => {
  const initial = buildCodexArgs("Inspect OTA", "read-only", { persist: true });
  assert.deepEqual(initial.slice(0, 4), ["exec", "--sandbox", "read-only", "--json"]);
  assert.ok(!initial.includes("--ephemeral"));

  const resumed = buildCodexArgs("Continue OTA", "workspace-write", {
    persist: true,
    resumeId: "11111111-1111-4111-8111-111111111111",
  });
  assert.deepEqual(resumed.slice(0, 2), ["exec", "resume"]);
  assert.ok(resumed.includes('sandbox_mode="workspace-write"'));
  assert.ok(resumed.includes("--json"));
  assert.ok(!resumed.includes("--ephemeral"));
  assert.ok(!resumed.includes("--sandbox"));
  assert.equal(resumed.at(-2), "11111111-1111-4111-8111-111111111111");
  assert.equal(resumed.at(-1), "Continue OTA");
});
