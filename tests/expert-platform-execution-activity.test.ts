import assert from "node:assert/strict";
import test from "node:test";
import { JsonlReader } from "../src/expert-platform/jsonl-reader.js";
import { mapExecutionActivity, StreamResultCollector } from "../src/expert-platform/execution-activity.js";

test("incremental JSONL handles split UTF-8 and line boundaries without retaining raw input", () => {
  const seen: unknown[] = [];
  const reader = new JsonlReader((event) => seen.push(event));
  const bytes = Buffer.from(
    '{"type":"assistant","message":{"content":[{"type":"text","text":"中文"}]}}\r\n{"type":"result","is_error":false,"subtype":"success","result":"OK"}',
  );
  for (const byte of bytes) reader.push(Buffer.from([byte]));
  reader.finish();
  assert.equal(seen.length, 2);
  assert.equal((seen[0] as { message: { content: { text: string }[] } }).message.content[0]?.text, "中文");
});

test("JSONL fails closed on malformed, oversized lines and overall limits", () => {
  assert.throws(() => new JsonlReader(() => {}).push(Buffer.from("{oops}\n")), /EXPERT_INVALID_STREAM_EVENT/);
  assert.throws(() => new JsonlReader(() => {}, 4).push(Buffer.from('{"a":1}\n')), /EXPERT_STREAM_LINE_LIMIT/);
  assert.throws(() => new JsonlReader(() => {}, 100, 5).push(Buffer.from("123456")), /EXPERT_STREAM_OUTPUT_LIMIT/);
  assert.throws(() => new JsonlReader(() => {}).push(Buffer.from('"not an object"\n')), /EXPERT_INVALID_STREAM_EVENT/);
});

test("Claude activity adapter emits safe tool vocabulary only", () => {
  const raw = {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "/secret/key" } },
        { type: "tool_use", name: "DangerousTool", input: "do not expose" },
        { type: "text", text: "private thinking" },
      ],
    },
  };
  const output = mapExecutionActivity("claude", raw);
  assert.deepEqual(output, [
    { kind: "tool.activity", tool: "Read", count: 1 },
    { kind: "tool.activity", tool: "other", count: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(output), /secret|private|DangerousTool/);
  assert.deepEqual(mapExecutionActivity("claude", { type: "system", subtype: "init" }), [{ kind: "model.started" }]);
});

test("Claude stream collector validates a single success result and rejects failure", () => {
  const collector = new StreamResultCollector("claude");
  collector.accept({ type: "assistant", message: { content: [{ type: "text", text: "not final" }] } });
  assert.throws(() => collector.result(), /CLAUDE_EXECUTION_FAILED/);
  collector.accept({ type: "result", subtype: "success", is_error: false, result: "final report" });
  assert.equal(collector.result(), "final report");
  assert.throws(
    () => collector.accept({ type: "result", subtype: "success", is_error: false, result: "again" }),
    /CLAUDE_INVALID_RESULT/,
  );
  const failure = new StreamResultCollector("claude");
  failure.accept({ type: "result", subtype: "error", is_error: true, result: "error" });
  assert.throws(() => failure.result(), /CLAUDE_EXECUTION_FAILED/);
});

test("Codex adapter yields safe activity and validates completed final message", () => {
  const collector = new StreamResultCollector("codex");
  collector.accept({ type: "item.completed", item: { type: "agent_message", text: "final" } });
  assert.throws(() => collector.result(), /CODEX_RESULT_MISSING/);
  collector.accept({ type: "turn.completed" });
  assert.equal(collector.result(), "final");
  assert.deepEqual(
    mapExecutionActivity("codex", {
      type: "item.started",
      item: { type: "command_execution", command: "cat /secret" },
    }),
    [{ kind: "tool.activity", tool: "other", count: 1 }],
  );
  const failure = new StreamResultCollector("codex");
  failure.accept({ type: "turn.failed" });
  assert.throws(() => failure.result(), /CODEX_TURN_FAILED/);
});

test("opt-in subprocess streaming produces activities and report before legacy buffer limit", async () => {
  const { runCodexProcess } = await import("../src/expert-platform/codex-process.js");
  const events = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "secret" } }] } },
    { type: "result", subtype: "success", is_error: false, result: "done" },
  ];
  const activities: string[] = [];
  const report = await runCodexProcess({
    executable: process.execPath,
    args: [
      "-e",
      `process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n") + "\n")})`,
    ],
    timeoutMs: 5000,
    streamingBackend: "claude",
    onActivity: (activity) => activities.push(activity.kind),
  });
  assert.equal(report, "done");
  assert.deepEqual(activities, ["model.started", "tool.activity", "model.completed"]);
});

test("streaming subprocess fails when missing terminal result", async () => {
  const { runCodexProcess } = await import("../src/expert-platform/codex-process.js");
  await assert.rejects(
    runCodexProcess({
      executable: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify('{"type":"system","subtype":"init"}\n')})`],
      timeoutMs: 5000,
      streamingBackend: "claude",
    }),
    /CLAUDE_EXECUTION_FAILED/,
  );
});
