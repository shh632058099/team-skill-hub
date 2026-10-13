import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_GOVERNANCE_HTML,
  ADMIN_HTML,
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

test("review and gap pages use user-facing filter labels", () => {
  assertContainsAll(ADMIN_MODULE_HTML, [
    "关键字",
    "状态",
    "仓库",
    "来源类型",
    "审核人",
    "自动候选",
    "候选类型",
    "Skill 分类",
    "每页数量",
    "筛选",
    "清除",
    "上一页",
    "下一页",
    "暂无记录",
  ]);
  assert.ok(!ADMIN_MODULE_HTML.includes("automatic true/false"));
});

test("module index pages remain summary-only entry pages", () => {
  assertContainsAll(ADMIN_MODULE_INDEX_HTML, [
    "/admin/review/candidates?status=pending",
    "/admin/gaps/items?status=active",
  ]);
  assert.ok(!ADMIN_MODULE_INDEX_HTML.includes("/admin/governance/repositories"));
  assert.ok(!ADMIN_MODULE_INDEX_HTML.includes("<table"));
  assert.ok(!ADMIN_MODULE_INDEX_HTML.includes("<pre"));
});

test("governance is a direct page and dashboard no longer embeds repository governance", () => {
  assertContainsAll(ADMIN_GOVERNANCE_HTML, ["仓库治理", "同步全部仓库", "/admin/api/repository-governance"]);
  assert.ok(!ADMIN_HTML.includes('id="repositoryGovernanceTable"'));
  assert.ok(!ADMIN_HTML.includes('id="repositoryGovernanceSummary"'));
  assert.ok(!ADMIN_HTML.includes('id="syncAllRepositories"'));
});
