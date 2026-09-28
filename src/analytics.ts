import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface UsageEvent {
  ts: string;
  actorId: string;
  tenantId: string;
  kind: "skill" | "prompt" | "agent";
  action: "search" | "resolve" | "load";
  query?: string;
  selected?: string;
  matched: boolean;
}

export class UsageAnalyticsStore {
  constructor(
    private readonly dataDir: string,
    private readonly maxEntries = 5000
  ) {}

  private file(): string {
    return path.join(this.dataDir, "analytics", "usage.jsonl");
  }

  private sanitizeQuery(query?: string): string | undefined {
    if (!query) return undefined;
    return query
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
      .replace(/(?:sk-|ghp_|glpat-)[A-Za-z0-9_-]{12,}/g, "[redacted-token]")
      .slice(0, 500);
  }

  async record(event: UsageEvent): Promise<void> {
    await mkdir(path.dirname(this.file()), { recursive: true });
    const safe = { ...event, query: this.sanitizeQuery(event.query) };
    await appendFile(this.file(), `${JSON.stringify(safe)}\n`, "utf8");
    await this.compactIfNeeded();
  }

  async list(limit = 200, unmatchedOnly = false): Promise<UsageEvent[]> {
    try {
      const rows = (await readFile(this.file(), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as UsageEvent);
      return rows
        .filter((item) => !unmatchedOnly || !item.matched)
        .slice(-Math.max(1, Math.min(limit, 1000)))
        .reverse();
    } catch {
      return [];
    }
  }

  async summary(limit = 10): Promise<{
    total: number;
    matched: number;
    unmatched: number;
    byKind: Record<string, number>;
    byAction: Record<string, number>;
    topSelected: Array<{ key: string; count: number }>;
    topUnmatchedQueries: Array<{ query: string; count: number }>;
  }> {
    const rows = await this.list(this.maxEntries, false);
    const byKind: Record<string, number> = {};
    const byAction: Record<string, number> = {};
    const selected = new Map<string, number>();
    const unmatchedQueries = new Map<string, number>();
    let matched = 0;
    for (const row of rows) {
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
      byAction[row.action] = (byAction[row.action] ?? 0) + 1;
      if (row.matched) matched += 1;
      if (row.selected) selected.set(row.selected, (selected.get(row.selected) ?? 0) + 1);
      if (!row.matched && row.query) {
        unmatchedQueries.set(row.query, (unmatchedQueries.get(row.query) ?? 0) + 1);
      }
    }
    const top = (values: Map<string, number>, keyName: "key" | "query") =>
      [...values.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.max(1, Math.min(limit, 50)))
        .map(([value, count]) => ({ [keyName]: value, count }));
    return {
      total: rows.length,
      matched,
      unmatched: rows.length - matched,
      byKind,
      byAction,
      topSelected: top(selected, "key") as Array<{ key: string; count: number }>,
      topUnmatchedQueries: top(unmatchedQueries, "query") as Array<{ query: string; count: number }>
    };
  }

  private async compactIfNeeded(): Promise<void> {
    try {
      const rows = (await readFile(this.file(), "utf8")).split("\n").filter(Boolean);
      if (rows.length <= this.maxEntries) return;
      await writeFile(this.file(), `${rows.slice(-this.maxEntries).join("\n")}\n`, "utf8");
    } catch {
      // Best-effort analytics must not break request handling.
    }
  }
}
