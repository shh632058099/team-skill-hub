import assert from "node:assert/strict";
import test from "node:test";
import { KNOWLEDGE_SUMMARY_SCHEMA_VERSION, parseKnowledgeSummary } from "../src/knowledge-summary.js";

const validSummary = [
  "# OTA 断电恢复修复",
  "",
  "## 问题",
  "设备升级过程中断电后可能无法恢复。",
  "",
  "## 根因",
  "恢复路径没有重新校验安全检查点和镜像完整性。",
  "",
  "## 解决方案",
  "从最后一个安全检查点恢复，并在启动前校验镜像版本与完整性。",
  "",
  "## 验证结果",
  "运行 12 项回归测试，结果为 12 passed, 0 failed。",
  "",
  "## 适用范围",
  "适用于支持断电恢复的 OTA 升级流程。",
  "",
  "## 约束/限制",
  "仍需在目标硬件上验证掉电时序。"
].join("\n");

test("parses and canonicalizes the fixed knowledge summary format", () => {
  const result = parseKnowledgeSummary(validSummary);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.summary.schemaVersion, KNOWLEDGE_SUMMARY_SCHEMA_VERSION);
  assert.equal(result.summary.title, "OTA 断电恢复修复");
  assert.equal(result.summary.markdown, validSummary);
});

test("accepts English section aliases and emits Chinese canonical headings", () => {
  const result = parseKnowledgeSummary([
    "# Verified Docker smoke test",
    "",
    "## Problem",
    "The MCP server must be reachable from WSL2.",
    "",
    "## Root Cause",
    "The client was using a stale endpoint.",
    "",
    "## Solution",
    "Configure the current MCP endpoint.",
    "",
    "## Verification",
    "The container reported 1 passed, 0 failed.",
    "",
    "## Applicability",
    "WSL2 Codex users.",
    "",
    "## Constraints",
    "Human review is still required."
  ].join("\n"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.summary.markdown, /## 问题/);
  assert.match(result.summary.markdown, /## 约束\/限制/);
});

test("rejects prose that is not an explicitly structured summary", () => {
  const result = parseKnowledgeSummary("The test passed and the fix is reusable.");
  assert.deepEqual(result, { ok: false, reason: "missing-title" });
});

test("rejects summaries missing a required section", () => {
  const result = parseKnowledgeSummary([
    "# Incomplete",
    "",
    "## 问题",
    "A problem.",
    "",
    "## 根因",
    "A cause.",
    "",
    "## 解决方案",
    "A solution.",
    "",
    "## 验证结果",
    "A passing test.",
    "",
    "## 适用范围",
    "A scope."
  ].join("\n"));
  assert.deepEqual(result, { ok: false, reason: "missing-constraints" });
});
