import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_SESSION_COOKIE,
  AdminLoginAttemptLimiter,
  AdminSessionManager,
  clearAdminSessionCookie,
  safeAdminNextPath,
  serializeAdminSessionCookie,
} from "../src/admin-auth.js";

test("admin login prefers ADMIN_PASSWORD and can fall back to ADMIN_API_KEY", () => {
  const preferred = new AdminSessionManager({ username: "root", password: "password-secret", apiKey: "api-secret" });
  assert.equal(preferred.verifyCredentials("root", "password-secret"), true);
  assert.equal(preferred.verifyCredentials("root", "api-secret"), false);
  assert.equal(preferred.verifyCredentials("other", "password-secret"), false);
  const fallback = new AdminSessionManager({ username: "admin", apiKey: "api-secret" });
  assert.equal(fallback.verifyCredentials("admin", "api-secret"), true);
  assert.equal(fallback.verifyCredentials("admin", "wrong"), false);
});

test("admin sessions expire, update activity and can be revoked", () => {
  let now = 1_700_000_000_000;
  const manager = new AdminSessionManager({ username: "admin", password: "secret", ttlSeconds: 60, now: () => now });
  const created = manager.createSession({ userAgent: "test-browser", remoteAddress: "127.0.0.1" });
  assert.equal(manager.authenticateToken(created.token)?.id, created.session.id);
  now += 10_000;
  assert.equal(manager.authenticateToken(created.token)?.lastSeenAt, new Date(now).toISOString());
  assert.equal(manager.listSessions(created.token)[0]?.current, true);
  assert.equal(manager.revokeSession(created.session.id), true);
  assert.equal(manager.authenticateToken(created.token), undefined);
  const expiring = manager.createSession({});
  now += 60_001;
  assert.equal(manager.authenticateToken(expiring.token), undefined);
  assert.equal(manager.listSessions().length, 0);
});

test("admin session manager bounds active sessions and stores only opaque token hashes", () => {
  let now = 1_700_000_000_000;
  const manager = new AdminSessionManager({ username: "admin", password: "secret", maxSessions: 2, now: () => now });
  const first = manager.createSession({});
  now += 1;
  manager.createSession({});
  now += 1;
  const third = manager.createSession({});
  assert.equal(manager.listSessions().length, 2);
  assert.equal(manager.authenticateToken(first.token), undefined);
  assert.ok(manager.authenticateToken(third.token));
  assert.equal(JSON.stringify(manager.listSessions()).includes(third.token), false);
});

test("admin session cookie is HttpOnly strict and optionally Secure", () => {
  const cookie = serializeAdminSessionCookie("opaque-token", 3600, true);
  assert.match(cookie, new RegExp("^" + ADMIN_SESSION_COOKIE + "=opaque-token;"));
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=3600/);
  assert.match(cookie, /Secure/);
  const cleared = clearAdminSessionCookie(true);
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Secure/);
});

test("admin next path only permits local admin pages", () => {
  assert.equal(safeAdminNextPath("/admin/observability?limit=20"), "/admin/observability?limit=20");
  assert.equal(safeAdminNextPath("/admin/login"), "/admin");
  assert.equal(safeAdminNextPath("https://evil.example/admin"), "/admin");
  assert.equal(safeAdminNextPath("javascript:alert(1)"), "/admin");
  assert.equal(safeAdminNextPath("/metrics"), "/admin");
  assert.equal(safeAdminNextPath("/administrator"), "/admin");
});

test("admin login limiter blocks repeated failures and resets on success/window expiry", () => {
  let now = 1_700_000_000_000;
  const limiter = new AdminLoginAttemptLimiter({ maxFailures: 2, windowMs: 60_000, now: () => now });
  assert.equal(limiter.canAttempt("127.0.0.1"), true);
  limiter.recordFailure("127.0.0.1");
  assert.equal(limiter.canAttempt("127.0.0.1"), true);
  limiter.recordFailure("127.0.0.1");
  assert.equal(limiter.canAttempt("127.0.0.1"), false);
  assert.ok(limiter.retryAfterSeconds("127.0.0.1") > 0);
  limiter.recordSuccess("127.0.0.1");
  assert.equal(limiter.canAttempt("127.0.0.1"), true);
  limiter.recordFailure("127.0.0.1");
  limiter.recordFailure("127.0.0.1");
  now += 60_001;
  assert.equal(limiter.canAttempt("127.0.0.1"), true);
});
