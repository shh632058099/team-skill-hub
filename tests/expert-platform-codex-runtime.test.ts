import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCodexReadOnlyArgs, parseCodexJsonlResult } from "../src/expert-platform/codex-runtime.js";

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
