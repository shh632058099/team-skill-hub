import assert from "node:assert/strict";
import { test } from "node:test";
import { workWaitRequiresHumanAction, workWaitShouldContinuePolling } from "../src/expert-platform/work-wait-policy.js";

const revision = "workspace:abc";

test("wait policy distinguishes human gates from automatic publication progress", () => {
  assert.equal(
    workWaitRequiresHumanAction({
      status: "waiting_review",
      currentSubjectRevision: revision,
      reviews: [],
      gateMissing: ["review_accepted"],
    }),
    true,
  );

  assert.equal(
    workWaitRequiresHumanAction({
      status: "waiting_review",
      currentSubjectRevision: revision,
      reviewTaskStatus: "running",
      reviews: [],
      gateMissing: ["review_accepted"],
    }),
    false,
  );

  assert.equal(
    workWaitRequiresHumanAction({
      status: "waiting_review",
      currentSubjectRevision: revision,
      reviews: [{ subjectRevision: revision, decision: "accepted" }],
      gateMissing: ["publication_succeeded", "change_request_created"],
    }),
    false,
  );

  assert.equal(
    workWaitRequiresHumanAction({
      status: "waiting_review",
      currentSubjectRevision: revision,
      reviews: [{ subjectRevision: revision, decision: "accepted" }],
      gateMissing: ["required_approval:work_completion"],
    }),
    true,
  );

  assert.equal(
    workWaitRequiresHumanAction({
      status: "waiting_review",
      currentSubjectRevision: revision,
      reviews: [{ subjectRevision: revision, decision: "accepted" }],
      gateMissing: ["required_approval:publish_work_branch", "publication_succeeded"],
      publicationCommitSha: null,
    }),
    false,
  );

  assert.equal(
    workWaitRequiresHumanAction({
      status: "waiting_review",
      currentSubjectRevision: revision,
      reviews: [{ subjectRevision: revision, decision: "accepted" }],
      gateMissing: ["required_approval:publish_work_branch", "publication_succeeded"],
      publicationCommitSha: "a".repeat(40),
    }),
    true,
  );

  assert.equal(
    workWaitRequiresHumanAction({
      status: "running",
      currentSubjectRevision: revision,
      reviews: [],
      gateMissing: [],
    }),
    false,
  );

  assert.equal(
    workWaitRequiresHumanAction({
      status: "blocked",
      currentSubjectRevision: revision,
      reviews: [],
      gateMissing: [],
    }),
    true,
  );

  assert.equal(workWaitShouldContinuePolling("waiting_review", false), true);
  assert.equal(workWaitShouldContinuePolling("waiting_review", true), false);
  assert.equal(workWaitShouldContinuePolling("running", false), true);
  assert.equal(workWaitShouldContinuePolling("blocked", true), false);
});
