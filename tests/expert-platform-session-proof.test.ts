import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyClientSessionProof, verifyClaudeSessionProof } from "../src/expert-platform/session-proof.js";

test("accepts only authenticated fresh hook session identity bound to the submit", () => {
  const sid = "57fa17ba-1e37-4f5d-b504-d7aa9c3c89df",
    key = "submit-1",
    auth = "secret",
    now = 1761700000000;
  const mac = createHmac("sha256", auth)
    .update(`team-skill-hub/client-session/v1\n${sid}\n${key}\n${now}`)
    .digest("hex");
  const proof = `${now}.${mac}`;
  assert.equal(verifyClientSessionProof(auth, sid, key, proof, now), true);
  assert.equal(verifyClaudeSessionProof(auth, sid, key, proof, now), true);
  const legacyMac = createHmac("sha256", auth)
    .update(`team-skill-hub/claude-session/v1\n${sid}\n${key}\n${now}`)
    .digest("hex");
  assert.equal(verifyClientSessionProof(auth, sid, key, `${now}.${legacyMac}`, now), true);
  assert.equal(verifyClaudeSessionProof(auth, sid, "submit-2", proof, now), false);
  assert.equal(verifyClaudeSessionProof("wrong", sid, key, proof, now), false);
  assert.equal(verifyClaudeSessionProof(auth, sid, key, proof, now + 301000), false);
  assert.equal(verifyClaudeSessionProof(auth, sid, key, undefined, now), false);
  assert.equal(verifyClaudeSessionProof(auth, sid, key, `${now}.${"0".repeat(64)}`, now), false);
});
