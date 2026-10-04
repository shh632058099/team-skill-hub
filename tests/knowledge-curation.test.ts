import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpKnowledgeCurator,
  validateCandidateCurationProposal,
  validateGapClusters
} from "../src/knowledge-curation.js";

test("candidate curation guard accepts bounded safe proposal", () => {
  const proposal = validateCandidateCurationProposal({
    title: "OTA power-loss recovery",
    summary: "Verified recovery behavior and reusable diagnostic steps.",
    category: "ota",
    suggestedPath: "docs/ota/power-loss-recovery.md",
    suggestedType: "knowledge",
    conflictHint: { targetKey: "rd:old.md", reason: "Overlaps an older recovery note" }
  });
  assert.equal(proposal.suggestedType, "knowledge");
  assert.equal(proposal.suggestedPath, "docs/ota/power-loss-recovery.md");
  assert.equal(proposal.conflictHint?.targetKey, "rd:old.md");
});

test("candidate curation guard rejects unsafe path and invalid type", () => {
  assert.throws(
    () => validateCandidateCurationProposal({ title: "x", summary: "y", suggestedType: "agent", suggestedPath: "docs/x.md" }),
    /suggestedType/
  );
  assert.throws(
    () => validateCandidateCurationProposal({ title: "x", summary: "y", suggestedType: "knowledge", suggestedPath: "../secret.md" }),
    /unsafe/
  );
});

test("gap curation guard only permits known unique gap members", () => {
  const gaps = [
    { key: "g1", query: "ota rollback", occurrences: 2, source: "search" },
    { key: "g2", query: "ota recovery", occurrences: 3, source: "feedback" },
    { key: "g3", query: "kernel panic", occurrences: 1, source: "search" }
  ];
  const clusters = validateGapClusters([
    { label: "OTA recovery", memberKeys: ["g1", "g2"], suggestedPath: "docs/ota/recovery.md" }
  ], gaps);
  assert.deepEqual(clusters[0]?.memberKeys, ["g1", "g2"]);
  assert.throws(
    () => validateGapClusters([{ label: "bad", memberKeys: ["g1", "missing"] }], gaps),
    /unknown gap/
  );
  assert.throws(
    () => validateGapClusters([
      { label: "one", memberKeys: ["g1", "g2"] },
      { label: "two", memberKeys: ["g2", "g3"] }
    ], gaps),
    /reuses gap/
  );
});

test("HTTP curator sends review constraints and validates response schema", async () => {
  const previousUrl = process.env.KNOWLEDGE_CURATOR_URL;
  const previousToken = process.env.KNOWLEDGE_CURATOR_TOKEN;
  process.env.KNOWLEDGE_CURATOR_URL = "https://curator.example.test/v1/curate";
  process.env.KNOWLEDGE_CURATOR_TOKEN = "test-token";
  let requestBody: Record<string, unknown> | undefined;
  const curator = new HttpKnowledgeCurator((async (_input, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer test-token");
    return new Response(JSON.stringify({
      schema_version: 1,
      proposal: {
        title: "Curated OTA recovery",
        summary: "Concise verified recovery guidance.",
        category: "ota",
        suggestedPath: "docs/ota/recovery.md",
        suggestedType: "knowledge"
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  try {
    const proposal = await curator.curateCandidate({
      id: "kc_1",
      ts: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      actorId: "u1",
      tenantId: "t1",
      title: "raw",
      content: "raw content",
      sourceType: "manual",
      suggestedType: "knowledge",
      status: "pending",
      history: []
    } as never);
    assert.equal(proposal.title, "Curated OTA recovery");
    assert.equal(requestBody?.action, "curate_candidate");
    const constraints = requestBody?.constraints as Record<string, unknown>;
    assert.equal(constraints.human_review_required, true);
    assert.equal(constraints.direct_knowledge_write, false);
    assert.equal(constraints.deterministic_guard_required, true);
  } finally {
    if (previousUrl === undefined) delete process.env.KNOWLEDGE_CURATOR_URL; else process.env.KNOWLEDGE_CURATOR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.KNOWLEDGE_CURATOR_TOKEN; else process.env.KNOWLEDGE_CURATOR_TOKEN = previousToken;
  }
});
