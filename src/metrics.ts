export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, { count: number; sumSeconds: number }>();

  increment(name: string, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observe(name: string, seconds: number, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    const current = this.durations.get(key) ?? { count: 0, sumSeconds: 0 };
    current.count += 1;
    current.sumSeconds += seconds;
    this.durations.set(key, current);
  }

  render(): string {
    const lines: string[] = [];
    for (const [key, value] of [...this.counters.entries()].sort()) {
      lines.push(`${key} ${value}`);
    }
    for (const [key, value] of [...this.durations.entries()].sort()) {
      lines.push(`${key}_count ${value.count}`);
      lines.push(`${key}_sum ${value.sumSeconds.toFixed(6)}`);
    }
    return `${lines.join("\n")}\n`;
  }

  private key(name: string, labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return name;
    const encoded = entries
      .map(([key, value]) => `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
      .join(",");
    return `${name}{${encoded}}`;
  }
}
