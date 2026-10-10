import { randomBytes } from "node:crypto";

interface Options {
  phase: "prepare" | "verify";
  hubUrl: string;
  repository: string;
  adminKeyEnv: string;
  candidateId?: string;
  marker?: string;
  suggestedPath?: string;
}

interface CandidateView {
  id: string;
  status: string;
  repository?: string;
  suggestedPath?: string;
  publication?: {
    branch?: string;
    targetBranch?: string;
    mergeRequestIid?: number;
    mergeRequestUrl?: string;
    mergeRequestState?: string;
    publishedAt?: string;
    mergedAt?: string;
    mergeCommitSha?: string;
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = argument(name)?.trim();
  if (!value) throw new Error(name + " is required");
  return value;
}

function parseOptions(): Options {
  const phase = required("--phase");
  if (phase !== "prepare" && phase !== "verify") {
    throw new Error("--phase must be prepare or verify");
  }
  const rawHubUrl = required("--hub-url");
  if (!/^https?:\/\//i.test(rawHubUrl)) throw new Error("--hub-url must start with http:// or https://");
  const repository = required("--repository");
  const adminKeyEnv = argument("--admin-key-env") ?? "ADMIN_API_KEY";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(adminKeyEnv)) throw new Error("--admin-key-env is invalid");
  const candidateId = argument("--candidate-id")?.trim();
  const marker = argument("--marker")?.trim();
  if (phase === "verify" && !candidateId) throw new Error("--candidate-id is required for verify");
  if (phase === "verify" && !marker) throw new Error("--marker is required for verify");
  return {
    phase,
    hubUrl: rawHubUrl.replace(/\/+$/, ""),
    repository,
    adminKeyEnv,
    ...(candidateId ? { candidateId } : {}),
    ...(marker ? { marker } : {}),
    ...(argument("--path")?.trim() ? { suggestedPath: argument("--path")!.trim() } : {})
  };
}

function defaultMarker(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return "skill-hub-sandbox-" + stamp + "-" + randomBytes(3).toString("hex");
}

function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function main(): Promise<void> {
  const opts = parseOptions();
  const adminKey = process.env[opts.adminKeyEnv];
  if (!adminKey) throw new Error("Missing admin key environment variable " + opts.adminKeyEnv);

  const request = async <T>(pathname: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(opts.hubUrl + pathname, {
      ...init,
      headers: {
        "x-skill-hub-admin-key": adminKey,
        "content-type": "application/json",
        ...(init.headers ?? {})
      }
    });
    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      throw new Error(pathname + " failed (" + response.status + "): " + String(text).slice(0, 1000));
    }
    return payload as T;
  };

  const ready = await fetch(opts.hubUrl + "/health/ready");
  if (!ready.ok) throw new Error("Hub readiness check failed with HTTP " + ready.status);

  if (opts.phase === "prepare") {
    const marker = opts.marker ?? defaultMarker();
    const suggestedPath = opts.suggestedPath ?? "knowledge/sandbox-acceptance-" + safeSlug(marker) + ".md";
    const title = "Team Skill Hub Sandbox Acceptance " + marker;
    const content = [
      "# Team Skill Hub Sandbox Acceptance " + marker,
      "",
      "## 问题",
      "需要验证候选知识从 Review 到 GitLab MR、合并、同步和检索的完整链路。验收标记：" + marker,
      "",
      "## 根因",
      "沙盒验收需要一个可追踪且不会与真实团队知识混淆的候选条目。",
      "",
      "## 解决方案",
      "通过 Team Skill Hub GitLab sandbox acceptance flow 创建并发布此候选。",
      "",
      "## 验证结果",
      "候选审核、GitLab MR 发布、Webhook 同步和人工合并后的检索结果均应可验证。",
      "",
      "## 适用范围",
      "仅适用于 Team Skill Hub GitLab 沙盒验收。",
      "",
      "## 约束/限制",
      "不得将此沙盒条目当作生产知识；验收标记必须保持可检索。"
    ].join("\n");

    const submitted = await request<{ candidate: CandidateView }>("/admin/api/knowledge-candidates", {
      method: "POST",
      body: JSON.stringify({
        title,
        content,
        suggestedType: "knowledge",
        repository: opts.repository,
        suggestedPath
      })
    });
    const candidateId = submitted.candidate?.id;
    if (!candidateId) throw new Error("Candidate creation did not return an id");

    await request("/admin/api/knowledge-candidates/" + encodeURIComponent(candidateId) + "/review", {
      method: "POST",
      body: JSON.stringify({
        status: "approved",
        reviewReason: "useful",
        reviewNote: "GitLab sandbox acceptance"
      })
    });

    const published = await request<{ candidate: CandidateView }>(
      "/admin/api/knowledge-candidates/" + encodeURIComponent(candidateId) + "/publish",
      { method: "POST", body: "{}" }
    );
    const publication = published.candidate?.publication;
    if (!publication?.mergeRequestUrl || !publication.branch || !publication.mergeRequestIid) {
      throw new Error("Publish completed without GitLab MR evidence");
    }

    console.log(JSON.stringify({
      ok: true,
      phase: "prepare",
      repository: opts.repository,
      candidateId,
      marker,
      suggestedPath,
      branch: publication.branch,
      targetBranch: publication.targetBranch,
      mergeRequestIid: publication.mergeRequestIid,
      mergeRequestUrl: publication.mergeRequestUrl,
      mergeRequestState: publication.mergeRequestState,
      humanActionRequired: "Review and merge the sandbox MR, then run phase=verify with candidateId and marker."
    }, null, 2));
    return;
  }

  const candidateId = opts.candidateId!;
  const marker = opts.marker!;
  const reconciled = await request<{ candidate: CandidateView }>(
    "/admin/api/knowledge-candidates/" + encodeURIComponent(candidateId) + "/reconcile",
    { method: "POST", body: "{}" }
  );
  const candidate = reconciled.candidate;
  const publication = candidate?.publication;
  if (candidate?.status !== "published") throw new Error("Candidate is not in published state");
  if (publication?.mergeRequestState !== "merged") {
    throw new Error("Merge Request is not merged; current state=" + String(publication?.mergeRequestState ?? "unknown"));
  }
  if (!publication.mergedAt) throw new Error("Merged publication is missing mergedAt evidence");

  const audit = await request<{ events: Array<{ ts: string; action: string; repositoryId: string; trigger: string }> }>(
    "/audit?repository=" + encodeURIComponent(opts.repository) + "&limit=200"
  );
  const mergedAt = Date.parse(publication.mergedAt);
  const webhookSync = audit.events?.find((event) =>
    event.repositoryId === opts.repository &&
    event.trigger === "webhook" &&
    event.action === "repository.sync.completed" &&
    Date.parse(event.ts) >= mergedAt
  );
  if (!webhookSync) {
    throw new Error("No successful repository webhook sync was recorded after MR merge");
  }

  const syncResult = await request<Record<string, unknown>>(
    "/repositories/" + encodeURIComponent(opts.repository) + "/sync",
    { method: "POST", body: "{}" }
  );

  const search = await request<{ results: Array<{ repository: string; path: string; title: string; content: string }> }>(
    "/admin/api/knowledge/search?q=" + encodeURIComponent(marker) +
      "&repository=" + encodeURIComponent(opts.repository) + "&limit=10"
  );
  const hit = search.results?.find((item) =>
    item.repository === opts.repository &&
    [item.path, item.title, item.content].some((value) => String(value ?? "").includes(marker))
  );
  if (!hit) throw new Error("RAG search did not return the sandbox marker after merge/sync");

  const listed = await request<{ candidates: CandidateView[] }>(
    "/admin/api/knowledge-candidates?id=" + encodeURIComponent(candidateId) + "&limit=10"
  );
  const finalCandidate = listed.candidates?.find((item) => item.id === candidateId);
  if (!finalCandidate) throw new Error("Candidate status could not be read back after verification");
  if (finalCandidate.status !== "published" || finalCandidate.publication?.mergeRequestState !== "merged") {
    throw new Error("Candidate publication status did not retain merged state");
  }

  console.log(JSON.stringify({
    ok: true,
    phase: "verify",
    repository: opts.repository,
    candidateId,
    marker,
    mergeRequestUrl: publication.mergeRequestUrl,
    mergeCommitSha: publication.mergeCommitSha,
    webhookSyncAt: webhookSync.ts,
    manualSync: syncResult,
    ragHit: { repository: hit.repository, path: hit.path, title: hit.title },
    candidateStatus: finalCandidate.status,
    mergeRequestState: finalCandidate.publication?.mergeRequestState
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
