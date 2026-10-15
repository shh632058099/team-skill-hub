import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_GOVERNANCE_HTML,
  ADMIN_HTML,
  ADMIN_LOGIN_HTML,
  ADMIN_MODULE_HTML,
  ADMIN_MODULE_INDEX_HTML,
  ADMIN_OBSERVABILITY_HTML,
  ADMIN_OBSERVABILITY_INDEX_HTML,
} from "../src/admin-ui.js";

function assertContainsAll(text: string, values: string[]): void {
  for (const value of values) assert.ok(text.includes(value), `expected HTML to contain ${value}`);
}

test("admin observability index stays an index instead of embedding legacy lists", () => {
  assertContainsAll(ADMIN_OBSERVABILITY_INDEX_HTML, [
    "/admin/observability/sessions",
    "/admin/observability/hooks",
    "/admin/observability/candidate-detections",
    "/admin/observability/mcp-calls",
    "/admin/observability/reuse",
    "/admin/observability/failures",
  ]);
  for (const legacyId of ["sessionsTable", "clientEventsTable", "candidateDetectionsTable", "callsTable", "operationalHealth", "sessionAnalytics"]) {
    assert.ok(!ADMIN_OBSERVABILITY_INDEX_HTML.includes(legacyId), `observability index should not contain ${legacyId}`);
  }
});

test("legacy admin tabs route migrated modules to stable pages", () => {
  assertContainsAll(ADMIN_HTML, [
    'observability:"/admin/observability"',
    'review:"/admin/review"',
    'gaps:"/admin/gaps"',
    'governance:"/admin/governance"',
    "location.href=stableRoute",
    "location.replace(stableRoute)",
    "审核中心",
    "Skill Bundle 导入",
  ]);
});

test("observability list filters use user-facing labels and boolean selects", () => {
  assertContainsAll(ADMIN_OBSERVABILITY_HTML, [
    "关键字",
    "用户 / Actor ID",
    "仓库",
    "会话状态",
    "运行时状态",
    "Hook 事件",
    "包含 MCP 调用",
    "包含证据",
    "发生知识复用",
    "开始时间（从）",
    "结束时间（到）",
    "每页数量",
    "筛选",
    "清除",
    "上一页",
    "下一页",
    "<option value='true'",
    "<option value='false'",
  ]);
  assert.ok(!ADMIN_OBSERVABILITY_HTML.includes(">Apply<"));
  assert.ok(!ADMIN_OBSERVABILITY_HTML.includes(">Clear<"));
  assert.ok(!ADMIN_OBSERVABILITY_HTML.includes(">Previous<"));
  assert.ok(!ADMIN_OBSERVABILITY_HTML.includes(">Next<"));
  assertContainsAll(ADMIN_OBSERVABILITY_HTML, [
    "data-actor",
    "data-tenant",
    'q.set("actorId",tr.dataset.actor)',
    'q.set("tenantId",tr.dataset.tenant)',
    'params.get("actorId")',
    'params.get("tenantId")',
  ]);
});

test("review center exposes unified filters and list controls", () => {
  assertContainsAll(ADMIN_MODULE_HTML, [
    "审核中心",
    "关键字",
    "状态",
    "内容类型",
    "Item Kind",
    "仓库",
    "来源类型",
    "审核人",
    "提交人",
    "Namespace / Skill 分类",
    "skillCollection",
    "Import Type",
    "每页数量",
    "筛选",
    "清除",
    "上一页",
    "下一页",
    "刷新",
    "暂无记录",
    "/admin/api/review-items",
    "externalPublicationUrl",
    "data-review-id",
    "reviewPrev",
    "reviewNext",
    "reviewRefresh",
  ]);
});

test("candidate and bundle details share the unified review shell with clickable actions", () => {
  assertContainsAll(ADMIN_MODULE_HTML, [
    "返回审核列表",
    "候选详情",
    "Bundle 详情",
    "历史记录",
    "批准",
    "拒绝",
    "发布 PR/MR",
    "刷新 PR/MR 状态",
    "打开 PR/MR",
    "PR/MR 编号",
    "源分支",
    "目标分支",
    "删除已发布内容",
    "重新批准",
    "删除 Candidate",
    "重试发布 PR/MR",
    "Namespace",
    "Import Type",
    "Replacement Root",
    "Snapshot",
    "Skill",
    "Files",
    "当前 Preview",
    "基于最新 Target 新建 Import",
    "runCandidateAction",
    "runBundleAction",
    "button.disabled=true",
    "button.disabled=false",
    "/admin/api/skill-bundles/",
    "/admin/api/knowledge-candidates/",
  ]);
  assertContainsAll(ADMIN_MODULE_HTML, ["target=\"_blank\"", "rel=\"noopener noreferrer\""]);
});

test("review landing cards remain categories but all statuses target one list", () => {
  assertContainsAll(ADMIN_MODULE_INDEX_HTML, [
    "审核中心",
    "/admin/review/items",
    "/admin/review/items?status=pending",
    "/admin/review/items?status=publishing",
    "/admin/review/items?status=review_stale",
    "/admin/review/items?status=published_drifted",
    "全部审核项",
    "待审核",
    "等待合并",
    "审核已过期",
    "发布内容漂移",
    "/admin/review/history",
    "历史记录",
    "/admin/api/review-summary",
  ]);
  assert.ok(!ADMIN_MODULE_INDEX_HTML.includes("/admin/review/candidates?status="));
  assert.ok(!ADMIN_MODULE_INDEX_HTML.includes("<table"));
});

test("review history exposes candidate and skill bundle sources truthfully", () => {
  assertContainsAll(ADMIN_MODULE_HTML, [
    "审核历史",
    "Candidate",
    "Skill Bundle",
    "historyType",
    "/admin/api/knowledge-candidates/history",
    "/admin/api/skill-bundles/",
    "查看 Bundle 历史",
    "未混合排序",
  ]);
});

test("legacy candidate routes normalize into the unified review center", () => {
  assertContainsAll(ADMIN_MODULE_HTML, [
    "/admin/review/candidates",
    "q.set('kind','candidate')",
    "/admin/review/items/candidate/",
    "location.replace",
  ]);
});
test("knowledge gap list keeps pagination controls after review-center refactor", () => {
  assertContainsAll(ADMIN_MODULE_HTML, [
    "gapPrev",
    "gapNext",
    "gapPage",
    "prev.disabled=!p.previousCursor",
    "next.disabled=!p.nextCursor",
    "最近出现",
  ]);
});

test("governance is a direct page and dashboard no longer embeds repository governance", () => {
  assertContainsAll(ADMIN_GOVERNANCE_HTML, ["仓库治理", "同步全部仓库", "/admin/api/repository-governance"]);
  assert.ok(
    ADMIN_GOVERNANCE_HTML.includes("<thead><tr><th>操作</th><th>仓库</th><th>Owner</th><th>状态</th>"),
    "repository governance table should keep 操作 as the first column"
  );
  assert.ok(
    ADMIN_GOVERNANCE_HTML.includes("row.appendChild(action);for(const value of values)"),
    "repository governance rows should append the action cell before data cells"
  );
  assert.ok(!ADMIN_HTML.includes('id="repositoryGovernanceTable"'));
  assert.ok(!ADMIN_HTML.includes('id="repositoryGovernanceSummary"'));
  assert.ok(!ADMIN_HTML.includes('id="syncAllRepositories"'));
});


test("admin login page and access tab expose browser session management", () => {
  assertContainsAll(ADMIN_LOGIN_HTML, ["管理员登录", "username", "password", "/admin/api/auth/login", "HttpOnly Session Cookie"]);
  assertContainsAll(ADMIN_HTML, ["adminLoginStatus", "adminSessionsTable", "adminLogout", "reloadAdminSessions", "revokeOtherAdminSessions", "/admin/api/auth/sessions"]);
});
