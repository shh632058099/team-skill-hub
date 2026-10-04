import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePreToolPolicy } from "../src/policy.js";

test("pre-tool policy allows ordinary read-only work", () => {
  const result = evaluatePreToolPolicy({
    toolName: "Bash",
    operation: "read",
    command: "git status --short",
    environment: "dev",
    roles: ["developer"]
  });
  assert.equal(result.decision, "allow");
  assert.deepEqual(result.matches, []);
});

test("pre-tool policy denies literal secrets and unconfirmed destructive commands", () => {
  const secret = evaluatePreToolPolicy({
    toolName: "Bash",
    command: "curl -H 'Authorization: token=glpat-1234567890abcdef' https://example.invalid"
  });
  assert.equal(secret.decision, "deny");
  assert.ok(secret.matches.some((item) => item.rule === "secret-detection"));
  const destructive = evaluatePreToolPolicy({
    toolName: "Bash",
    operation: "write",
    command: "git reset --hard HEAD~1"
  });
  assert.equal(destructive.decision, "deny");
  assert.ok(destructive.matches.some((item) => item.rule === "destructive-command"));
  assert.equal(
    evaluatePreToolPolicy({
      toolName: "Bash",
      operation: "write",
      command: "git reset --hard HEAD~1",
      confirmed: true
    }).decision,
    "allow"
  );
});

test("pre-tool policy enforces production customer and restricted environment guards", () => {
  assert.equal(
    evaluatePreToolPolicy({ toolName: "deploy", operation: "deploy", environment: "production", roles: ["developer"] }).decision,
    "deny"
  );
  assert.equal(
    evaluatePreToolPolicy({
      toolName: "git",
      operation: "push",
      repositoryVisibility: ["customer"],
      roles: ["developer"],
      confirmed: true
    }).decision,
    "deny"
  );
  assert.equal(
    evaluatePreToolPolicy({
      toolName: "device-farm",
      operation: "write",
      environment: "restricted",
      roles: ["restricted-env"]
    }).decision,
    "allow"
  );
});
