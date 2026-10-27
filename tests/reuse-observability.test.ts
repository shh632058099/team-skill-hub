import test from "node:test";
import assert from "node:assert/strict";
import { observeReuse } from "../src/reuse-observability.js";
import { isReuseMcpTool } from "../src/observability-tools.js";

test("search records bounded result metadata without document content", () => {
  const result = observeReuse("search_knowledge", {
    results: [
      {
        repository: "rd-knowledges",
        path: "knowledge/a.md",
        title: "A",
        content: "secret document content",
        score: 0.94,
      },
    ],
  });
  assert.equal(result?.event, "hit");
  assert.equal(result?.resultCount, 1);
  assert.equal(result?.topScore, 0.94);
  assert.deepEqual(result?.assets, [{ repository: "rd-knowledges", path: "knowledge/a.md", title: "A", score: 0.94 }]);
  assert.doesNotMatch(JSON.stringify(result), /secret document content/);
});

test("empty search is MISS, successful load is LOAD", () => {
  assert.deepEqual(observeReuse("search_skills", { results: [] }), { event: "miss", resultCount: 0, assets: [] });
  assert.deepEqual(
    observeReuse("get_knowledge", {
      repository: "rd-knowledges",
      path: "knowledge/a.md",
      title: "A",
      content: "private",
    }),
    { event: "load", assets: [{ repository: "rd-knowledges", path: "knowledge/a.md", title: "A" }] },
  );
  assert.equal(isReuseMcpTool("resolve_skill"), true);
  assert.equal(isReuseMcpTool("get_skill_resource"), true);
});

test("discover captures skill and knowledge results without prompt content", () => {
  const result = observeReuse("discover", {
    selected: { type: "skill" },
    skills: [{ repository: "rd-skills", path: "skills/ota/SKILL.md", name: "ota", score: 5 }],
    knowledge: [{ repository: "rd-knowledges", path: "knowledge/a.md", title: "A", score: 3, content: "private" }],
  });
  assert.equal(result?.event, "hit");
  assert.equal(result?.resultCount, 2);
  assert.equal(result?.assets.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("bound assets to five and truncate long fields", () => {
  const result = observeReuse("search_skills", {
    results: Array.from({ length: 18 }, (_, i) => ({ repository: "r", path: "p".repeat(800), title: String(i) })),
  });
  assert.equal(result?.resultCount, 18);
  assert.equal(result?.assets.length, 5);
  assert.equal(result?.assets[0]?.path.length, 200);
  assert.equal(observeReuse("unrelated_tool", { results: [] }), undefined);
});

test("knowledge match respects configured score threshold while preserving returned result count", () => {
  const response = { results: [{ repository: "rd-knowledges", path: "knowledge/a.md", score: 0.21 }] };
  assert.equal(observeReuse("search_knowledge", response, { knowledgeMatchMinScore: 0.5 })?.event, "miss");
  assert.equal(observeReuse("search_knowledge", response, { knowledgeMatchMinScore: 0.1 })?.event, "hit");
  assert.equal(observeReuse("search_knowledge", response)?.event, "hit");
});
