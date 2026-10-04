import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function listen(server: http.Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("missing test server address"));
      else resolve(address.port);
    });
  });
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("GitLab sandbox acceptance CLI keeps human merge boundary and verifies webhook/sync/RAG", async () => {
  const marker = "skill-hub-sandbox-test-marker";
  const candidateId = "kc_sandbox_test";
  const repository = "rd-skills";
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const openedPublication = {
    branch: "skill-hub-knowledge-sandbox",
    targetBranch: "master",
    mergeRequestIid: 17,
    mergeRequestUrl: "https://gitlab.example.test/ai/rd-skills/-/merge_requests/17",
    mergeRequestState: "opened",
    publishedAt: "2026-10-04T00:00:00.000Z"
  };
  const mergedPublication = {
    ...openedPublication,
    mergeRequestState: "merged",
    mergedAt: "2026-10-04T00:05:00.000Z",
    mergeCommitSha: "abcdef0123456789"
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let bodyText = "";
    for await (const chunk of request) bodyText += chunk;
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    requests.push({ method: request.method ?? "GET", path: url.pathname + url.search, ...(body !== undefined ? { body } : {}) });

    const send = (status: number, payload: unknown) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
    };

    if (url.pathname === "/health/ready") return send(200, { ready: true });
    if (request.headers["x-skill-hub-admin-key"] !== "sandbox-admin-key") return send(403, { error: "denied" });

    if (url.pathname === "/admin/api/knowledge-candidates" && request.method === "POST") {
      return send(201, { candidate: { id: candidateId, status: "pending", repository } });
    }
    if (url.pathname === `/admin/api/knowledge-candidates/${candidateId}/review`) {
      return send(200, { candidate: { id: candidateId, status: "approved", repository } });
    }
    if (url.pathname === `/admin/api/knowledge-candidates/${candidateId}/publish`) {
      return send(200, { candidate: { id: candidateId, status: "published", repository, publication: openedPublication } });
    }
    if (url.pathname === `/admin/api/knowledge-candidates/${candidateId}/reconcile`) {
      return send(200, { candidate: { id: candidateId, status: "published", repository, publication: mergedPublication } });
    }
    if (url.pathname === "/audit") {
      return send(200, {
        events: [{
          ts: "2026-10-04T00:05:02.000Z",
          action: "repository.sync.completed",
          repositoryId: repository,
          trigger: "webhook"
        }]
      });
    }
    if (url.pathname === `/repositories/${repository}/sync`) {
      return send(200, { id: repository, status: "healthy", revision: "merge-revision" });
    }
    if (url.pathname === "/admin/api/knowledge/search") {
      return send(200, {
        results: [{
          repository,
          path: `knowledge/sandbox-acceptance-${marker}.md`,
          title: `Team Skill Hub Sandbox Acceptance ${marker}`,
          content: `Sandbox acceptance marker: ${marker}`
        }]
      });
    }
    if (url.pathname === "/admin/api/knowledge-candidates" && request.method === "GET") {
      return send(200, {
        candidates: [{ id: candidateId, status: "published", repository, publication: mergedPublication }],
        page: { total: 1, limit: 10, cursor: "0" }
      });
    }
    return send(404, { error: "not found" });
  });

  const port = await listen(server);
  const hubUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, SANDBOX_ADMIN_KEY: "sandbox-admin-key" };
  try {
    const prepare = await execFileAsync(process.execPath, [
      "--import", "tsx", "src/cli/gitlab-sandbox-acceptance.ts",
      "--phase", "prepare",
      "--hub-url", hubUrl,
      "--repository", repository,
      "--admin-key-env", "SANDBOX_ADMIN_KEY",
      "--marker", marker
    ], { cwd: process.cwd(), env });
    const prepared = JSON.parse(prepare.stdout);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.phase, "prepare");
    assert.equal(prepared.candidateId, candidateId);
    assert.equal(prepared.marker, marker);
    assert.equal(prepared.mergeRequestState, "opened");
    assert.match(prepared.humanActionRequired, /merge/i);

    const submit = requests.find((item) => item.method === "POST" && item.path === "/admin/api/knowledge-candidates");
    assert.ok(submit);
    assert.equal((submit!.body as Record<string, unknown>).repository, repository);
    assert.match(String((submit!.body as Record<string, unknown>).content), new RegExp(marker));

    const verify = await execFileAsync(process.execPath, [
      "--import", "tsx", "src/cli/gitlab-sandbox-acceptance.ts",
      "--phase", "verify",
      "--hub-url", hubUrl,
      "--repository", repository,
      "--admin-key-env", "SANDBOX_ADMIN_KEY",
      "--candidate-id", candidateId,
      "--marker", marker
    ], { cwd: process.cwd(), env });
    const verified = JSON.parse(verify.stdout);
    assert.equal(verified.ok, true);
    assert.equal(verified.phase, "verify");
    assert.equal(verified.mergeRequestState, "merged");
    assert.equal(verified.webhookSyncAt, "2026-10-04T00:05:02.000Z");
    assert.equal(verified.ragHit.repository, repository);
    assert.match(verified.ragHit.path, new RegExp(marker));

    const auditIndex = requests.findIndex((item) => item.path.startsWith("/audit?"));
    const manualSyncIndex = requests.findIndex((item) => item.path === `/repositories/${repository}/sync`);
    assert.ok(auditIndex >= 0 && manualSyncIndex > auditIndex, "webhook evidence must be checked before manual sync");
  } finally {
    await close(server);
  }
});
