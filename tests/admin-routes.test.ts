import assert from "node:assert/strict";
import test from "node:test";
import { adminRouteUrl, normalizeAdminLimit, paginateAdminRows, parseAdminRoute, redactAdminValue, safeAdminReturnPath } from "../src/admin-routes.js";

test("admin History API routes parse stable list and detail paths", () => {
  assert.deepEqual(parseAdminRoute("http://x/admin/observability"), { kind: "index", path: "/admin/observability" });
  for (const resource of ["sessions", "hooks", "candidate-detections", "mcp-calls", "reuse", "failures"] as const) {
    assert.deepEqual(parseAdminRoute(`http://x/admin/observability/${resource}?q=abc`), { kind: "list", resource, path: `/admin/observability/${resource}` });
    assert.deepEqual(parseAdminRoute(`http://x/admin/observability/${resource}/id%2F1`), { kind: "detail", resource, id: "id/1", path: `/admin/observability/${resource}/id%2F1` });
  }
  assert.equal(parseAdminRoute("http://x/admin#observability").kind, "legacy");
});

test("admin module routes keep bounded index/list/detail pathname semantics", () => {
  assert.deepEqual(parseAdminRoute("http://x/admin/review"), { kind: "module-index", module: "review", path: "/admin/review" });
  assert.deepEqual(parseAdminRoute("http://x/admin/governance"), { kind: "governance", path: "/admin/governance" });
  assert.deepEqual(parseAdminRoute("http://x/admin/review/candidates?status=pending"), { kind: "module", module: "review", resource: "candidates", path: "/admin/review/candidates" });
  assert.deepEqual(parseAdminRoute("http://x/admin/gaps/items/g%2F1"), { kind: "module", module: "gaps", resource: "items", id: "g/1", path: "/admin/gaps/items/g%2F1" });
  assert.deepEqual(parseAdminRoute("http://x/admin/governance/repositories/r1"), { kind: "module", module: "governance", resource: "repositories", id: "r1", path: "/admin/governance/repositories/r1" });
});

test("admin route parsing tolerates malformed percent-encoded ids", () => {
  assert.doesNotThrow(() => parseAdminRoute("http://x/admin/observability/sessions/%E0%A4%A"));
  assert.deepEqual(parseAdminRoute("http://x/admin/observability/sessions/%E0%A4%A"), {
    kind: "detail",
    resource: "sessions",
    id: "%E0%A4%A",
    path: "/admin/observability/sessions/%E0%A4%A"
  });
  assert.doesNotThrow(() => parseAdminRoute("http://x/admin/gaps/items/%ZZ"));
});

test("admin pagination query helpers default to 20 and cap at 100", () => {
  for (const [input, expected] of [[undefined, 20], [20, 20], ["50", 50], [100, 100], ["101", 100], ["invalid", 20]] as const) assert.equal(normalizeAdminLimit(input), expected);
  assert.equal(adminRouteUrl(parseAdminRoute("http://x/admin/observability/sessions"), new URLSearchParams("q=one&limit=50")), "/admin/observability/sessions?q=one&limit=50");
});

test("admin pagination handles cursor boundaries after filtering", () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({ id: index, text: index < 5 ? `keep-${index}` : `drop-${index}` }));
  const first = paginateAdminRows(rows, { limit: "2", q: "keep" }, (row) => row.text);
  assert.deepEqual(first.items.map((row) => row.id), [0, 1]);
  assert.deepEqual(first.page, { total: 5, limit: 2, cursor: "0", nextCursor: "2", previousCursor: undefined });

  const middle = paginateAdminRows(rows, { limit: "2", cursor: "2", q: "keep" }, (row) => row.text);
  assert.deepEqual(middle.items.map((row) => row.id), [2, 3]);
  assert.equal(middle.page.previousCursor, "0");
  assert.equal(middle.page.nextCursor, "4");

  const last = paginateAdminRows(rows, { limit: "2", cursor: "4", q: "keep" }, (row) => row.text);
  assert.deepEqual(last.items.map((row) => row.id), [4]);
  assert.equal(last.page.nextCursor, undefined);
  assert.equal(last.page.previousCursor, "2");

  for (const cursor of ["-10", "invalid", "Infinity", "NaN"] as const) {
    assert.equal(paginateAdminRows(rows, { limit: "2", cursor }, (row) => row.text).page.cursor, "0");
  }
  assert.equal(paginateAdminRows(rows, { limit: "2", cursor: "3.9" }, (row) => row.text).page.cursor, "3");
  const beyond = paginateAdminRows(rows, { limit: "2", cursor: "99" }, (row) => row.text);
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.page.cursor, "99");
  assert.equal(beyond.page.nextCursor, undefined);
});

test("admin detail redaction recursively clones nested records", () => {
  const input = { token: "top", nested: { password: "pw", safe: "ok", values: [{ apiKey: "key", accessKey: "access" }] }, private_key: "private", authorization: "Bearer x" };
  const output = redactAdminValue(input) as Record<string, any>;
  assert.equal(output.token, "[redacted]");
  assert.equal(output.nested.password, "[redacted]");
  assert.equal(output.nested.values[0].apiKey, "[redacted]");
  assert.equal(output.nested.values[0].accessKey, "[redacted]");
  assert.equal(output.private_key, "[redacted]");
  assert.equal(output.nested.safe, "ok");
  assert.equal(input.nested.password, "pw");
});

test("admin detail return paths stay on the expected admin module", () => {
  const fallback = "/admin/observability/sessions";
  assert.equal(
    safeAdminReturnPath("/admin/observability/sessions?q=one&limit=50", fallback, "/admin/observability/"),
    "/admin/observability/sessions?q=one&limit=50"
  );
  assert.equal(safeAdminReturnPath("javascript:alert(1)", fallback, "/admin/observability/"), fallback);
  assert.equal(
    safeAdminReturnPath("https://example.com/admin/observability/sessions", fallback, "/admin/observability/"),
    fallback
  );
  assert.equal(safeAdminReturnPath("/admin/review/candidates", fallback, "/admin/observability/"), fallback);
});
