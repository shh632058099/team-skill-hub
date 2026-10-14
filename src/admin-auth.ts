import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_COOKIE = "skill_hub_admin_session";

export interface AdminSessionView {
  id: string;
  username: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent?: string;
  remoteAddress?: string;
  current?: boolean;
}

interface AdminSessionRecord extends Omit<AdminSessionView, "current"> {
  tokenHash: string;
}

export interface AdminSessionManagerOptions {
  username?: string;
  password?: string;
  apiKey?: string;
  ttlSeconds?: number;
  maxSessions?: number;
  now?: () => number;
}

function secretDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(secretDigest(left), secretDigest(right));
}


export class AdminLoginAttemptLimiter {
  private readonly attempts = new Map<string, { failures: number; startedAt: number }>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options?: { maxFailures?: number; windowMs?: number; now?: () => number }) {
    this.maxFailures = Math.max(1, Math.floor(options?.maxFailures ?? 5));
    this.windowMs = Math.max(1000, Math.floor(options?.windowMs ?? 5 * 60 * 1000));
    this.now = options?.now ?? Date.now;
  }

  private current(key: string) {
    const value = this.attempts.get(key);
    if (!value) return undefined;
    if (this.now() - value.startedAt >= this.windowMs) { this.attempts.delete(key); return undefined; }
    return value;
  }

  canAttempt(key: string): boolean {
    return (this.current(key)?.failures ?? 0) < this.maxFailures;
  }

  recordFailure(key: string): void {
    const current = this.current(key);
    if (current) current.failures += 1;
    else this.attempts.set(key, { failures: 1, startedAt: this.now() });
  }

  recordSuccess(key: string): void { this.attempts.delete(key); }

  retryAfterSeconds(key: string): number {
    const current = this.current(key);
    if (!current || current.failures < this.maxFailures) return 0;
    return Math.max(1, Math.ceil((current.startedAt + this.windowMs - this.now()) / 1000));
  }
}

export class AdminSessionManager {
  readonly username: string;
  readonly ttlSeconds: number;
  readonly maxSessions: number;
  private readonly credential?: string;
  private readonly now: () => number;
  private readonly sessions = new Map<string, AdminSessionRecord>();
  private readonly tokenIndex = new Map<string, string>();

  constructor(options: AdminSessionManagerOptions) {
    this.username = options.username?.trim() || "admin";
    this.credential = options.password !== undefined && options.password !== "" ? options.password : options.apiKey || undefined;
    this.ttlSeconds = Math.max(1, Math.floor(options.ttlSeconds ?? 8 * 60 * 60));
    this.maxSessions = Math.max(1, Math.floor(options.maxSessions ?? 20));
    this.now = options.now ?? Date.now;
  }

  get credentialsConfigured(): boolean {
    return Boolean(this.credential);
  }

  verifyCredentials(username: string, password: string): boolean {
    if (!this.credential) return false;
    return constantTimeEqual(username, this.username) && constantTimeEqual(password, this.credential);
  }

  private removeSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    this.tokenIndex.delete(session.tokenHash);
    return true;
  }

  private cleanupExpired(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (Date.parse(session.expiresAt) <= now) this.removeSession(session.id);
    }
  }

  createSession(metadata: { userAgent?: string; remoteAddress?: string }): { token: string; session: AdminSessionView } {
    this.cleanupExpired();
    while (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!oldest) break;
      this.removeSession(oldest.id);
    }
    const now = this.now();
    const token = randomBytes(32).toString("base64url");
    const record: AdminSessionRecord = {
      id: randomUUID(),
      username: this.username,
      tokenHash: tokenHash(token),
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlSeconds * 1000).toISOString(),
      userAgent: metadata.userAgent?.slice(0, 300),
      remoteAddress: metadata.remoteAddress?.slice(0, 100)
    };
    this.sessions.set(record.id, record);
    this.tokenIndex.set(record.tokenHash, record.id);
    return { token, session: this.toView(record, true) };
  }

  authenticateToken(token: string | undefined): AdminSessionView | undefined {
    if (!token) return undefined;
    this.cleanupExpired();
    const hash = tokenHash(token);
    const id = this.tokenIndex.get(hash);
    if (!id) return undefined;
    const record = this.sessions.get(id);
    if (!record) return undefined;
    record.lastSeenAt = new Date(this.now()).toISOString();
    return this.toView(record, true);
  }

  listSessions(currentToken?: string): AdminSessionView[] {
    this.cleanupExpired();
    const currentHash = currentToken ? tokenHash(currentToken) : undefined;
    return [...this.sessions.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((session) => this.toView(session, currentHash === session.tokenHash));
  }

  revokeSession(id: string): boolean {
    return this.removeSession(id);
  }

  revokeToken(token: string | undefined): boolean {
    if (!token) return false;
    const id = this.tokenIndex.get(tokenHash(token));
    return id ? this.removeSession(id) : false;
  }

  revokeOtherSessions(currentToken: string | undefined): number {
    const currentHash = currentToken ? tokenHash(currentToken) : undefined;
    let revoked = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.tokenHash === currentHash) continue;
      if (this.removeSession(session.id)) revoked += 1;
    }
    return revoked;
  }

  private toView(record: AdminSessionRecord, current: boolean): AdminSessionView {
    return {
      id: record.id,
      username: record.username,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
      expiresAt: record.expiresAt,
      userAgent: record.userAgent,
      remoteAddress: record.remoteAddress,
      current
    };
  }
}

export function adminSessionTokenFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    if (key !== ADMIN_SESSION_COOKIE) continue;
    return pair.slice(separator + 1).trim() || undefined;
  }
  return undefined;
}

export function serializeAdminSessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    ADMIN_SESSION_COOKIE + "=" + token,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=" + Math.max(1, Math.floor(maxAgeSeconds)),
    secure ? "Secure" : undefined
  ].filter(Boolean).join("; ");
}

export function clearAdminSessionCookie(secure: boolean): string {
  return [
    ADMIN_SESSION_COOKIE + "=",
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    secure ? "Secure" : undefined
  ].filter(Boolean).join("; ");
}

export function safeAdminNextPath(value: string | undefined): string {
  if (!value) return "/admin";
  try {
    const url = new URL(value, "http://admin.local");
    if (url.origin !== "http://admin.local") return "/admin";
    if ((url.pathname !== "/admin" && !url.pathname.startsWith("/admin/")) || url.pathname === "/admin/login") return "/admin";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/admin";
  }
}
