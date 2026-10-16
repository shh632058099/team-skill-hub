import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { KnowledgeSubmissionSpecStore, defaultKnowledgeSubmissionSpec } from "../src/knowledge-submission-spec.js";
import { KnowledgeSpecOutdatedError, KnowledgeSubmissionService } from "../src/knowledge-submission.js";

const validSummary = [
  "# OTA recovery",
  "",
  "## Problem",
  "Power loss interrupts an update.",
  "",
  "## Root Cause",
  "Recovery did not validate the checkpoint.",
  "",
  "## Solution",
  "Resume from the last verified checkpoint.",
  "",
  "## Verification",
  "12 regression tests passed.",
  "",
  "## Scope",
  "OTA systems with checkpoint recovery.",
  "",
  "## Constraints / limitations",
  "Target hardware timing still needs validation.",
].join("\n");

async function serviceWithStore() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-knowledge-submission-"));
  const store = new KnowledgeSubmissionSpecStore(dataDir);
  return { store, service: new KnowledgeSubmissionService(store) };
}

test("service exposes model-ready current spec, template and instruction", async () => {
  const { service } = await serviceWithStore();
  const view = await service.currentSpec();
  assert.equal(view.spec_version, 1);
  assert.equal(view.schema_version, 1);
  assert.match(view.template, /## 问题/);
  assert.match(view.instruction, /spec_version/);
  assert.equal(view.rules.content.max_chars, 50_000);
});

test("normalizes English aliases into headings from the active spec", async () => {
  const { service } = await serviceWithStore();
  const normalized = await service.normalize({ title: "ignored", content: validSummary, submittedSpecVersion: 1 });
  assert.equal(normalized.title, "OTA recovery");
  assert.match(normalized.content, /## 问题\nPower loss interrupts an update\./);
  assert.match(normalized.content, /## 约束\/限制/);
  assert.equal(normalized.appliedSpecVersion, 1);
  assert.equal(normalized.submittedSpecVersion, 1);
});

test("accepts summaries up to 50000 characters and rejects current invalid content", async () => {
  const { service } = await serviceWithStore();
  const padded = validSummary.replace("Power loss interrupts an update.", "A".repeat(40_000));
  assert.ok(padded.length < 50_000);
  await service.normalize({ title: "ignored", content: padded, submittedSpecVersion: 1 });
  await assert.rejects(
    service.normalize({ title: "ignored", content: validSummary + "\n" + "A".repeat(50_000), submittedSpecVersion: 1 }),
    /Knowledge candidate content does not satisfy current submission spec: too-long/,
  );
});

test("stale compatible content is accepted but stale incompatible content returns KNOWLEDGE_SPEC_OUTDATED", async () => {
  const { store, service } = await serviceWithStore();
  const base = defaultKnowledgeSubmissionSpec();
  await store.saveNext({ ...base, content: { ...base.content, max_chars: 600 } });
  const compatible = await service.normalize({ title: "ignored", content: validSummary, submittedSpecVersion: 1 });
  assert.equal(compatible.appliedSpecVersion, 2);
  assert.equal(compatible.submittedSpecVersion, 1);
  const oversized = validSummary.replace("Power loss interrupts an update.", "A".repeat(700));
  await assert.rejects(
    service.normalize({ title: "ignored", content: oversized, submittedSpecVersion: 1 }),
    (error: unknown) =>
      error instanceof KnowledgeSpecOutdatedError &&
      error.code === "KNOWLEDGE_SPEC_OUTDATED" &&
      error.currentSpecVersion === 2,
  );
});

test("future submitted spec versions fail as invalid input", async () => {
  const { service } = await serviceWithStore();
  await assert.rejects(
    service.normalize({ title: "ignored", content: validSummary, submittedSpecVersion: 9 }),
    /Unknown knowledge submission spec version: 9/,
  );
});

test("structured drafts render through the current spec and refuse missing or placeholder required values", async () => {
  const { service } = await serviceWithStore();
  const built = await service.buildFromStructuredDraft({
    title: "Verified recovery",
    problem: "Power loss interrupts update.",
    rootCause: "Checkpoint verification was missing.",
    solution: "Validate and resume checkpoint.",
    verification: "Regression suite passed.",
    applicability: "Checkpoint based OTA.",
    constraints: "Hardware timing remains platform-specific.",
  });
  assert.match(built.content, /# Verified recovery/);
  assert.match(built.content, /## 验证结果\nRegression suite passed\./);
  await assert.rejects(
    service.buildFromStructuredDraft({
      title: "Bad draft",
      problem: "Problem",
      rootCause: "unknown",
      solution: "Solution",
      verification: "Verified",
      applicability: "Scope",
      constraints: "Limits",
    }),
    /missing-required-knowledge-field: root_cause/,
  );
});
