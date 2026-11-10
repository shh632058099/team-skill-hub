import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ChangeRequestProvider,
  ChangeRequestResult,
  CreateChangeRequestInput,
} from "../src/expert-platform/change-request-provider.js";

test("change request provider consumes only a pushed publication identity and has no merge operation", async () => {
  const contractModule = await import("../src/expert-platform/change-request-provider.js");
  assert.deepEqual(Object.keys(contractModule), []);
  const input: CreateChangeRequestInput = {
    repositoryIdentity: "repo-identity@7",
    headBranch: "skillhub/work/work1-a1",
    headCommit: "c".repeat(40),
    baseBranch: "main",
    title: "Fix OTA",
    body: "Generated from an approved Publication Artifact",
    idempotencyKey: "publication:pub-1",
    credentialGrantRef: "change-request-grant",
  };
  let received: CreateChangeRequestInput | null = null;
  const provider: ChangeRequestProvider = {
    async create(value) {
      received = value;
      return {
        provider: "test",
        externalId: "cr-1",
        url: "https://example.test/change/1",
        headCommit: value.headCommit,
        baseBranch: value.baseBranch,
      };
    },
  };
  const result: ChangeRequestResult = await provider.create(input);
  assert.deepEqual(received, input);
  assert.equal(result.headCommit, input.headCommit);
  assert.equal(result.baseBranch, "main");
  assert.equal("merge" in provider, false);
  assert.equal("repositoryUrl" in input, false);
  assert.equal("cloneUrl" in input, false);
});
