import assert from "node:assert/strict";
import test from "node:test";
import {
  DATA_GOVERNANCE_POLICY,
  governanceRuleForObservabilityFile,
  listDataGovernanceRules
} from "../src/data-governance.js";

test("data governance blocks persistence for sensitive raw data classes", () => {
  for (const classification of ["source-code", "customer-data", "sensitive-credential", "personal-data"] as const) {
    assert.equal(DATA_GOVERNANCE_POLICY[classification].collect, false);
    assert.equal(DATA_GOVERNANCE_POLICY[classification].persist, false);
    assert.equal(DATA_GOVERNANCE_POLICY[classification].retentionDays, 0);
  }
});

test("observability files use explicit classification retention", () => {
  assert.equal(governanceRuleForObservabilityFile("client-events.jsonl").retentionDays, 30);
  assert.equal(governanceRuleForObservabilityFile("candidate-detections.jsonl").retentionDays, 90);
  assert.equal(governanceRuleForObservabilityFile("knowledge-candidates.jsonl").retentionDays, 365);
  assert.equal(governanceRuleForObservabilityFile("feedback.jsonl").classification, "audit");
  assert.equal(listDataGovernanceRules().length, 9);
});
