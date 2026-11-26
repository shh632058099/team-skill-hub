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

test("Claude activity exposes bounded visible model text without tool arguments or thinking blocks", () => {
  const raw = {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "/secret/key" } },
        { type: "thinking", thinking: "hidden chain of thought" },
        { type: "text", text: "Reviewing retry path. Authorization: Bearer secret-token" },
        { type: "tool_use", name: "DangerousTool", input: "do not expose" },
      ],
    },
  };
  const output = mapExecutionActivity("claude", raw);
  assert.deepEqual(output, [
    { kind: "tool.activity", tool: "Read", count: 1 },
    { kind: "model.output", details: "Reviewing retry path. Authorization: Bearer [REDACTED]" },
    { kind: "tool.activity", tool: "other", count: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(output), /\/secret\/key|hidden chain|secret-token|DangerousTool|do not expose/);
  assert.deepEqual(mapExecutionActivity("claude", { type: "system", subtype: "init" }), [{ kind: "model.started" }]);
});

test("structured model failures expose only a fixed diagnostic code", () => {
  assert.deepEqual(
    mapExecutionActivity("claude", {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "HTTP 429 quota exceeded secret-provider-message",
    }),
    [{ kind: "model.failed", details: "MODEL_RATE_LIMITED" }],
  );
  assert.deepEqual(
    mapExecutionActivity("codex", {
      type: "turn.failed",
      error: { message: "TLS connection timeout secret-provider-message" },
    }),
    [{ kind: "model.failed", details: "MODEL_NETWORK_FAILED" }],
  );
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
  assert.deepEqual(
    mapExecutionActivity("codex", {
      type: "item.completed",
      item: { type: "agent_message", text: "Build is still running; token=secret-value" },
    }),
    [{ kind: "model.output", details: "Build is still running; token=[REDACTED]" }],
  );
  const failure = new StreamResultCollector("codex");
  failure.accept({ type: "turn.failed" });
  assert.throws(() => failure.result(), /CODEX_TURN_FAILED/);
});

test("stream collectors capture bounded runtime session identity", () => {
  const claude = new StreamResultCollector("claude");
  claude.accept({ type: "system", subtype: "init", session_id: "33333333-3333-4333-8333-333333333333" });
  claude.accept({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: "33333333-3333-4333-8333-333333333333",
  });
  assert.equal(claude.sessionId(), "33333333-3333-4333-8333-333333333333");

  const codex = new StreamResultCollector("codex");
  codex.accept({ type: "thread.started", thread_id: "44444444-4444-4444-8444-444444444444" });
  codex.accept({ type: "item.completed", item: { type: "agent_message", text: "done" } });
  codex.accept({ type: "turn.completed" });
  assert.equal(codex.sessionId(), "44444444-4444-4444-8444-444444444444");

  assert.throws(
    () => codex.accept({ type: "thread.started", thread_id: "x".repeat(201) }),
    /INVALID_RUNTIME_SESSION_ID/,
  );
});

test("opt-in subprocess streaming produces activities and report before legacy buffer limit", async () => {
  const { runAgentProcess } = await import("../src/expert-platform/agent-process.js");
  const events = [
    { type: "system", subtype: "init", session_id: "77777777-7777-4777-8777-777777777777" },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "secret" } }] } },
    { type: "result", subtype: "success", is_error: false, result: "done" },
  ];
  const activities: string[] = [];
  let runtimeSessionId = "";
  const report = await runAgentProcess({
    executable: process.execPath,
    args: [
      "-e",
      `process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n") + "\n")})`,
    ],
    timeoutMs: 5000,
    streamingBackend: "claude",
    onActivity: (activity) => activities.push(activity.kind),
    onRuntimeSessionId: (sessionId) => {
      runtimeSessionId = sessionId;
    },
  });
  assert.equal(report, "done");
  assert.equal(runtimeSessionId, "77777777-7777-4777-8777-777777777777");
  assert.deepEqual(activities, ["model.started", "tool.activity", "model.completed"]);
});

test("streaming subprocess fails when missing terminal result", async () => {
  const { runAgentProcess } = await import("../src/expert-platform/agent-process.js");
  await assert.rejects(
    runAgentProcess({
      executable: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify('{"type":"system","subtype":"init"}\n')})`],
      timeoutMs: 5000,
      streamingBackend: "claude",
    }),
    /CLAUDE_EXECUTION_FAILED/,
  );
});
