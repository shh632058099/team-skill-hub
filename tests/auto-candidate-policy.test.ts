import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AutoCandidatePolicyStore,
  defaultAutoCandidatePolicy,
  validateAutoCandidatePolicy,
} from "../src/auto-candidate/policy-store.js";

async function tempDir() {
  return await mkdtemp(path.join(os.tmpdir(), "skill-hub-auto-candidate-policy-"));
}

test("default auto candidate policy is conservative shadow policy", () => {
  const policy = defaultAutoCandidatePolicy();
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.policyVersion, 1);
  assert.equal(policy.enabled, true);
  assert.equal(policy.mode, "shadow");
  assert.deepEqual(policy.thresholds, {
    shadowScore: 60,
    createScore: 80,
    duplicateSimilarity: 0.84,
  });
  assert.deepEqual(policy.requirements, { requireVerification: true });
  assert.deepEqual(policy.limits, {
    perSession: 1,
    perUserPerHour: 2,
    perUserPerDay: 5,
    perRepositoryPerHour: 5,
    perRepositoryPerDay: 20,
    globalPerHour: 10,
    globalPerDay: 50,
  });
  assert.deepEqual(policy.cooldown, { sameRepositoryMinutes: 5 });
});

test("validation rejects invalid thresholds and negative limits", () => {
  const base = defaultAutoCandidatePolicy();
  assert.throws(
    () => validateAutoCandidatePolicy({ ...base, thresholds: { ...base.thresholds, createScore: 101 } }),
    /Invalid auto candidate policy/,
  );
  assert.throws(
    () =>
      validateAutoCandidatePolicy({ ...base, thresholds: { ...base.thresholds, shadowScore: 90, createScore: 80 } }),
    /shadowScore must not exceed createScore/,
  );
  assert.throws(
    () => validateAutoCandidatePolicy({ ...base, limits: { ...base.limits, globalPerDay: -1 } }),
    /globalPerDay/,
  );
});

test("store falls back to built-in policy when current file is absent", async () => {
  const store = new AutoCandidatePolicyStore(await tempDir());
  assert.deepEqual(await store.loadCurrent(), defaultAutoCandidatePolicy());
});

test("store versions saves and rollback monotonically", async () => {
  const dataDir = await tempDir();
  const store = new AutoCandidatePolicyStore(dataDir);
  const first = await store.saveNext({
    ...defaultAutoCandidatePolicy(),
    thresholds: { ...defaultAutoCandidatePolicy().thresholds, createScore: 85 },
  });
  assert.equal(first.policyVersion, 2);
  assert.equal(first.thresholds.createScore, 85);

  const second = await store.saveNext({
    ...first,
    limits: { ...first.limits, globalPerDay: 40 },
  });
  assert.equal(second.policyVersion, 3);

  const rolled = await store.rollbackTo(1);
  assert.equal(rolled.policyVersion, 4);
  assert.equal(rolled.thresholds.createScore, 80);
  assert.equal((await store.loadCurrent()).policyVersion, 4);

  const history = await store.history();
  assert.deepEqual(
    history.map((item) => item.policyVersion),
    [4, 3, 2, 1],
  );
});

test("store fails closed on malformed persisted current policy", async () => {
  const dataDir = await tempDir();
  const dir = path.join(dataDir, "config", "auto-candidate-policy");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "current.json"), JSON.stringify({ schemaVersion: 1, policyVersion: 7 }), "utf8");
  const store = new AutoCandidatePolicyStore(dataDir);
  await assert.rejects(store.loadCurrent(), /Invalid auto candidate policy/);
});

test("concurrent saves are serialized and preserve immutable history", async () => {
  const dataDir = await tempDir();
  const store = new AutoCandidatePolicyStore(dataDir);
  const base = defaultAutoCandidatePolicy();
  const [a, b] = await Promise.all([
    store.saveNext({ ...base, thresholds: { ...base.thresholds, createScore: 85 } }),
    store.saveNext({ ...base, thresholds: { ...base.thresholds, createScore: 90 } }),
  ]);
  assert.deepEqual(new Set([a.policyVersion, b.policyVersion]), new Set([2, 3]));

  const current = JSON.parse(
    await readFile(path.join(dataDir, "config", "auto-candidate-policy", "current.json"), "utf8"),
  );
  assert.equal(current.policyVersion, 3);
});
