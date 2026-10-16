import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpObservabilityStore } from "../../src/observability.js";

const principal = { id: "reviewer", tenantId: "rd", roles: ["developer"] };
test("sqlite persists feedback candidate history/delete and gap management across reopen", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-state-sqlite-"));
  try {
    let store = new McpObservabilityStore(root, 10000, { writeBackend: "sqlite", readBackend: "sqlite" });
    const feedback = await store.submitFeedback(principal, {
      rating: "negative",
      targetType: "knowledge",
      target: "k1",
      reason: "missing docs",
    });
    const candidate = await store.createCandidate(principal, {
      title: "T",
      content: "C",
      sourceType: "manual",
      suggestedType: "knowledge",
    });
    await store.reviewCandidate(candidate.id, "approved", "reviewer", undefined, "useful");
    await store.updateKnowledgeGapManagement("gap-1", { status: "ignored", keywords: ["one"] });
    await store.updateKnowledgeGapManagement("gap-1", { status: "active", candidateId: candidate.id });
    store.close();
    await rm(path.join(root, "observability"), { recursive: true, force: true });
    store = new McpObservabilityStore(root, 10000, { writeBackend: "sqlite", readBackend: "sqlite" });
    assert.equal((await store.listFeedback(20))[0]?.id, feedback.id);
    assert.equal((await store.getCandidate(candidate.id))?.status, "approved");
    assert.equal((await store.getCandidateHistory(candidate.id)).length, 2);
    const gaps = await store.listKnowledgeGapManagement();
    assert.equal(gaps.get("gap-1")?.status, "active");
    assert.equal(gaps.get("gap-1")?.ignoredAt, undefined);
    assert.equal(gaps.get("gap-1")?.candidateId, candidate.id);
    assert.equal(await store.deleteCandidate(candidate.id), true);
    assert.equal(await store.getCandidate(candidate.id), undefined);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
