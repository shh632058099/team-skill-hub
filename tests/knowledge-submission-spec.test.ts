import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  KnowledgeSubmissionSpecStore,
  defaultKnowledgeSubmissionSpec,
  validateKnowledgeSubmissionSpec,
} from "../src/knowledge-submission-spec.js";

async function tempDir() {
  return await mkdtemp(path.join(os.tmpdir(), "skill-hub-knowledge-spec-"));
}

test("default knowledge submission spec matches the existing six-section contract", () => {
  const spec = defaultKnowledgeSubmissionSpec();
  assert.equal(spec.schema_version, 1);
  assert.equal(spec.spec_version, 1);
  assert.equal(spec.title.max_chars, 160);
  assert.equal(spec.title.recommended_min_chars, 20);
  assert.equal(spec.title.recommended_max_chars, 80);
  assert.equal(spec.content.max_chars, 50_000);
  assert.deepEqual(
    spec.sections.map((s) => s.id),
    ["problem", "root_cause", "solution", "verification", "applicability", "constraints"],
  );
  assert.deepEqual(
    spec.sections.map((s) => s.heading),
    ["问题", "根因", "解决方案", "验证结果", "适用范围", "约束/限制"],
  );
});

test("store falls back to built-in v1 only when no persisted current spec exists", async () => {
  const dataDir = await tempDir();
  const store = new KnowledgeSubmissionSpecStore(dataDir);
  assert.deepEqual(await store.loadCurrent(), defaultKnowledgeSubmissionSpec());
});

test("save creates monotonic history and rollback creates a new version", async () => {
  const dataDir = await tempDir();
  const store = new KnowledgeSubmissionSpecStore(dataDir);
  const first = await store.saveNext({
    ...defaultKnowledgeSubmissionSpec(),
    title: { ...defaultKnowledgeSubmissionSpec().title, max_chars: 120 },
  });
  assert.equal(first.spec_version, 2);
  assert.equal(first.title.max_chars, 120);
  const second = await store.saveNext({ ...first, content: { ...first.content, max_chars: 40_000 } });
  assert.equal(second.spec_version, 3);
  const history = await store.history();
  assert.deepEqual(
    history.map((s) => s.spec_version),
    [3, 2, 1],
  );
  const rolled = await store.rollbackTo(1);
  assert.equal(rolled.spec_version, 4);
  assert.equal(rolled.title.max_chars, 160);
  assert.equal(rolled.content.max_chars, 50_000);
  assert.equal((await store.loadCurrent()).spec_version, 4);
});

test("store fails closed on malformed persisted current spec", async () => {
  const dataDir = await tempDir();
  const dir = path.join(dataDir, "config", "knowledge-submission-spec");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "current.json"),
    JSON.stringify({ schema_version: 1, spec_version: 7, sections: [] }),
    "utf8",
  );
  const store = new KnowledgeSubmissionSpecStore(dataDir);
  await assert.rejects(store.loadCurrent(), /Invalid knowledge submission spec/);
});

test("concurrent saves are serialized and never reuse a spec version", async () => {
  const dataDir = await tempDir();
  const store = new KnowledgeSubmissionSpecStore(dataDir);
  const base = defaultKnowledgeSubmissionSpec();
  const [a, b] = await Promise.all([
    store.saveNext({ ...base, title: { ...base.title, max_chars: 150 } }),
    store.saveNext({ ...base, title: { ...base.title, max_chars: 140 } }),
  ]);
  assert.deepEqual(new Set([a.spec_version, b.spec_version]), new Set([2, 3]));
  const current = JSON.parse(
    await readFile(path.join(dataDir, "config", "knowledge-submission-spec", "current.json"), "utf8"),
  );
  assert.equal(current.spec_version, 3);
});

test("existing next-version history is immutable but identical orphan history can recover current", async () => {
  const dataDir = await tempDir();
  const dir = path.join(dataDir, "config", "knowledge-submission-spec");
  const historyDir = path.join(dir, "history");
  await mkdir(historyDir, { recursive: true });
  const base = defaultKnowledgeSubmissionSpec();
  const orphan = { ...base, spec_version: 2, title: { ...base.title, max_chars: 120 } };
  await writeFile(path.join(historyDir, "v2.json"), JSON.stringify(orphan, null, 2) + "\n", "utf8");

  const store = new KnowledgeSubmissionSpecStore(dataDir);
  const recovered = await store.saveNext({ ...base, title: { ...base.title, max_chars: 120 } });
  assert.equal(recovered.spec_version, 2);
  assert.equal((await store.loadCurrent()).title.max_chars, 120);

  await writeFile(path.join(dir, "current.json"), JSON.stringify(base, null, 2) + "\n", "utf8");
  await assert.rejects(
    store.saveNext({ ...base, title: { ...base.title, max_chars: 110 } }),
    /immutable history version v2 already exists with different content/,
  );
  const persisted = JSON.parse(await readFile(path.join(historyDir, "v2.json"), "utf8"));
  assert.equal(persisted.title.max_chars, 120);
  assert.equal((await store.loadCurrent()).spec_version, 1);
});

test("validation rejects unsupported section ids and invalid limits", () => {
  const bad = {
    ...defaultKnowledgeSubmissionSpec(),
    title: { ...defaultKnowledgeSubmissionSpec().title, max_chars: 0 },
  };
  assert.throws(() => validateKnowledgeSubmissionSpec(bad), /Invalid knowledge submission spec/);
  const tooLongTitle = {
    ...defaultKnowledgeSubmissionSpec(),
    title: { ...defaultKnowledgeSubmissionSpec().title, max_chars: 201 },
  };
  assert.throws(() => validateKnowledgeSubmissionSpec(tooLongTitle), /title\.max_chars must not exceed 200/);
  const tooLongContent = {
    ...defaultKnowledgeSubmissionSpec(),
    content: { ...defaultKnowledgeSubmissionSpec().content, max_chars: 50_001 },
  };
  assert.throws(() => validateKnowledgeSubmissionSpec(tooLongContent), /content\.max_chars must not exceed 50000/);
  const badSection = defaultKnowledgeSubmissionSpec();
  (badSection.sections as any).push({ id: "extra", heading: "Extra", required: true });
  assert.throws(() => validateKnowledgeSubmissionSpec(badSection), /Invalid knowledge submission spec/);
});
