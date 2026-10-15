export type AdminRoute =
  | { kind: "index"; path: "/admin/observability" }
  | { kind: "governance"; path: "/admin/governance" }
  | { kind: "module-index"; module: "review" | "gaps"; path: string }
  | { kind: "review-list"; path: "/admin/review/items" }
  | { kind: "review-detail"; reviewKind: "candidate" | "skill-bundle"; id: string; subresource?: "history"; path: string }
  | { kind: "module"; module: "review" | "gaps" | "governance"; resource: string; id?: string; subresource?: string; path: string }
  | { kind: "list"; resource: "sessions" | "hooks" | "candidate-detections" | "mcp-calls" | "reuse" | "failures"; path: string }
  | { kind: "detail"; resource: "sessions" | "hooks" | "candidate-detections" | "mcp-calls" | "reuse" | "failures"; id: string; path: string }
  | { kind: "legacy"; path: string };

const resources = new Set(["sessions", "hooks", "candidate-detections", "mcp-calls", "reuse", "failures"]);
const sensitiveAdminKey = /(?:token|secret|password|authorization|api[_-]?key|access[_-]?key|private[_-]?key)/i;

function decodeAdminRouteId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function redactAdminValue(value: unknown, key?: string): unknown {
  if (key && sensitiveAdminKey.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactAdminValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactAdminValue(childValue, childKey)]));
  }
  return value;
}

export function parseAdminRoute(input: string | URL): AdminRoute {
  const url = typeof input === "string" ? new URL(input, "http://admin.local") : input;
  const path = url.pathname.replace(/\/$/, "") || "/admin";
  if (path === "/admin/observability") return { kind: "index", path };
  if (path === "/admin/governance") return { kind: "governance", path };
  if (path === "/admin/review/items") return { kind: "review-list", path };
  const reviewDetailMatch = path.match(/^\/admin\/review\/items\/(candidate|skill-bundle)\/([^/]+)(?:\/(history))?$/);
  if (reviewDetailMatch) {
    return {
      kind: "review-detail",
      reviewKind: reviewDetailMatch[1] as "candidate" | "skill-bundle",
      id: decodeAdminRouteId(reviewDetailMatch[2]!),
      ...(reviewDetailMatch[3] ? { subresource: "history" as const } : {}),
      path
    };
  }
  const moduleMatch = path.match(/^\/admin\/(review|gaps|governance)(?:\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?)?$/);
  if (moduleMatch) {
    const module = moduleMatch[1] as "review" | "gaps" | "governance";
    if (!moduleMatch[2]) return { kind: "module-index", module: module as "review" | "gaps", path };
    return moduleMatch[3]
      ? { kind: "module", module, resource: moduleMatch[2]!, id: decodeAdminRouteId(moduleMatch[3]), ...(moduleMatch[4] ? { subresource: moduleMatch[4] } : {}), path }
      : { kind: "module", module, resource: moduleMatch[2]!, path };
  }
  const match = path.match(/^\/admin\/observability\/([^/]+)(?:\/([^/]+))?$/);
  if (match && resources.has(match[1]!)) {
    const resource = match[1] as "sessions" | "hooks" | "candidate-detections" | "mcp-calls" | "reuse" | "failures";
    return match[2]
      ? { kind: "detail", resource, id: decodeAdminRouteId(match[2]!), path }
      : { kind: "list", resource, path };
  }
  return { kind: "legacy", path };
}

export function adminRouteUrl(route: AdminRoute, query?: URLSearchParams): string {
  const search = query && query.toString() ? `?${query}` : "";
  return `${route.path}${search}`;
}

export function normalizeAdminLimit(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 20);
  return Math.max(1, Math.min(Number.isFinite(parsed) ? Math.floor(parsed) : 20, 100));
}

export function paginateAdminRows<T>(
  rows: T[],
  query: { limit?: string; cursor?: string; q?: string },
  searchableText: (row: T) => string
) {
  const limit = normalizeAdminLimit(query.limit);
  const q = query.q?.trim().toLowerCase();
  const filtered = q
    ? rows.filter((row) => searchableText(row).toLowerCase().includes(q))
    : rows;
  const parsedCursor = Number(query.cursor ?? 0);
  const offset = Number.isFinite(parsedCursor) && parsedCursor > 0 ? Math.floor(parsedCursor) : 0;
  const items = filtered.slice(offset, offset + limit);
  return {
    items,
    page: {
      total: filtered.length,
      limit,
      cursor: String(offset),
      nextCursor: offset + limit < filtered.length ? String(offset + limit) : undefined,
      previousCursor: offset > 0 ? String(Math.max(0, offset - limit)) : undefined
    }
  };
}

export function safeAdminReturnPath(
  value: string | null | undefined,
  fallback: string,
  allowedPrefix = "/admin/"
): string {
  if (!value) return fallback;
  try {
    const url = new URL(value, "http://admin.local");
    if (url.origin !== "http://admin.local") return fallback;
    if (!url.pathname.startsWith(allowedPrefix)) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
