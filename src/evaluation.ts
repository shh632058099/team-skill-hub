import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type {
  AgentArtifact,
  EvaluationCase,
  EvaluationCaseResult,
  EvaluationRunResult,
  EvaluationSuite,
  KnowledgeDocument,
  PromptArtifact,
  Skill
} from "./types.js";
import { scanAgents, scanPrompts, searchArtifacts } from "./artifacts.js";
import { scanSkills } from "./skills.js";
import { SearchRoutingStrategy, SqliteFtsSearchBackend } from "./search.js";
import { chunksForDocuments, KnowledgeIndex, scanKnowledge } from "./knowledge.js";

interface EvaluationFile {
  schema_version?: number;
  id?: string;
  description?: string;
  cases?: EvaluationCase[];
}

export interface EvaluationSnapshot {
  repositoryId: string;
  revision: string;
  root: string;
  skills: Skill[];
  prompts: PromptArtifact[];
  agents: AgentArtifact[];
  knowledge: KnowledgeDocument[];
  suites: EvaluationSuite[];
}

async function walkEvaluationFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name === "EVALUATION.yaml") result.push(full);
    }
  }
  await visit(root);
  return result.sort();
}

export async function scanEvaluationSuites(
  root: string,
  repositoryId: string
): Promise<EvaluationSuite[]> {
  const suites: EvaluationSuite[] = [];
  for (const file of await walkEvaluationFiles(root)) {
    const raw = YAML.parse(await readFile(file, "utf8")) as EvaluationFile;
    if ((raw.schema_version ?? 1) !== 1) {
      throw new Error(`Evaluation suite ${file}: schema_version must be 1`);
    }
    if (!raw.id || !raw.description || !Array.isArray(raw.cases) || raw.cases.length === 0) {
      throw new Error(`Invalid evaluation suite: ${file}`);
    }
    const caseIds = new Set<string>();
    for (const testCase of raw.cases) {
      if (!testCase.id || caseIds.has(testCase.id)) {
        throw new Error(`Evaluation suite ${raw.id}: duplicate or missing case id`);
      }
      caseIds.add(testCase.id);
      if (
        !["skill", "prompt", "agent", "knowledge"].includes(testCase.target) ||
        !["search", "resolve", "get"].includes(testCase.operation)
      ) {
        throw new Error(`Evaluation suite ${raw.id}: invalid case ${testCase.id}`);
      }
      if (!testCase.expect || typeof testCase.expect !== "object") {
        throw new Error(`Evaluation suite ${raw.id}: case ${testCase.id} requires expect`);
      }
      if (
        (testCase.operation === "search" || testCase.operation === "resolve") &&
        !testCase.query
      ) {
        throw new Error(`Evaluation suite ${raw.id}: case ${testCase.id} requires query`);
      }
      if (testCase.operation === "get" && !testCase.name) {
        throw new Error(`Evaluation suite ${raw.id}: case ${testCase.id} requires name`);
      }
      if (testCase.target === "knowledge" && testCase.operation !== "search") {
        throw new Error(`Evaluation suite ${raw.id}: knowledge case ${testCase.id} only supports search`);
      }
      if (testCase.target === "knowledge" && !testCase.expect.selected) {
        throw new Error(`Evaluation suite ${raw.id}: knowledge case ${testCase.id} requires expect.selected path`);
      }
    }
    suites.push({
      schemaVersion: raw.schema_version ?? 1,
      id: raw.id,
      description: raw.description,
      repositoryId,
      relativePath: path.relative(root, file).replaceAll("\\", "/"),
      cases: raw.cases
    });
  }
  return suites;
}

export async function loadEvaluationSnapshot(
  root: string,
  repositoryId: string,
  revision: string
): Promise<EvaluationSnapshot> {
  const [skills, prompts, agents, knowledge, suites] = await Promise.all([
    scanSkills(root, repositoryId, revision),
    scanPrompts(root, repositoryId, revision),
    scanAgents(root, repositoryId, revision),
    scanKnowledge(root, repositoryId, revision),
    scanEvaluationSuites(root, repositoryId)
  ]);
  return { repositoryId, revision, root, skills, prompts, agents, knowledge, suites };
}

function includesAll(actual: string[], expected?: string[]): boolean {
  return (expected ?? []).every((value) => actual.includes(value));
}

function evaluateContent(content: string, contains?: string[]): string | undefined {
  for (const required of contains ?? []) {
    if (!content.includes(required)) return `missing required content: ${required}`;
  }
  return undefined;
}

function evaluateCase(
  testCase: EvaluationCase,
  snapshot: EvaluationSnapshot
): EvaluationCaseResult {
  try {
    if (testCase.target === "skill") {
      if (testCase.operation === "get") {
        const skill = snapshot.skills.find((item) => item.name === testCase.name);
        if (!skill) return { id: testCase.id, passed: false, message: "skill not found" };
        const contentIssue = evaluateContent(skill.content, testCase.expect.contains);
        if (contentIssue) return { id: testCase.id, passed: false, message: contentIssue };
        return { id: testCase.id, passed: true, message: "matched", actual: skill.name };
      }
      const search = new SqliteFtsSearchBackend();
      try {
        search.rebuild(snapshot.skills);
        const router = new SearchRoutingStrategy(search);
        const results =
          testCase.operation === "resolve"
            ? router.resolve(
                testCase.query!,
                {
                  repositories: [snapshot.repositoryId],
                  client: testCase.client
                },
                5
              )
            : search.search(
                testCase.query!,
                {
                  repositories: [snapshot.repositoryId],
                  client: testCase.client
                },
                5
              );
        const selected = results[0]?.skill;
        const expected = testCase.expect.selected;
        const passed =
          Boolean(selected) &&
          (!expected || selected?.name === expected) &&
          (!testCase.expect.repository || selected?.repositoryId === testCase.expect.repository);
        return {
          id: testCase.id,
          passed,
          message: passed ? "matched" : `expected ${expected ?? "a result"}, got ${selected?.name ?? "none"}`,
          actual: results.map((item) => ({ name: item.skill.name, score: item.score }))
        };
      } finally {
        search.close();
      }
    }

    if (testCase.target === "knowledge") {
      const index = new KnowledgeIndex();
      try {
        index.rebuild(chunksForDocuments(snapshot.knowledge));
        const results = index.search(
          testCase.query!,
          [snapshot.repositoryId],
          5,
          [snapshot.repositoryId]
        );
        const expectedPath = testCase.expect.selected!;
        const rankIndex = results.findIndex((item) => item.chunk.relativePath === expectedPath);
        const rank = rankIndex >= 0 ? rankIndex + 1 : undefined;
        return {
          id: testCase.id,
          passed: rank !== undefined && rank <= 5,
          message: rank ? `expected ${expectedPath} ranked #${rank}` : `expected ${expectedPath} not found in top 5`,
          rank,
          actual: results.map((item) => ({
            path: item.chunk.relativePath,
            chunkIndex: item.chunk.chunkIndex,
            score: item.score
          }))
        };
      } finally {
        index.close();
      }
    }

    if (testCase.target === "prompt") {
      if (testCase.operation === "get") {
        const prompt = snapshot.prompts.find((item) => item.name === testCase.name);
        if (!prompt) return { id: testCase.id, passed: false, message: "prompt not found" };
        const contentIssue = evaluateContent(prompt.content, testCase.expect.contains);
        if (contentIssue) return { id: testCase.id, passed: false, message: contentIssue };
        return { id: testCase.id, passed: true, message: "matched", actual: prompt.name };
      }
      const candidates = snapshot.prompts.filter(
        (item) => !testCase.client || item.compatibility[testCase.client] !== false
      );
      const results = searchArtifacts(testCase.query!, candidates, 5);
      const selected = results[0]?.artifact;
      const expected = testCase.expect.selected;
      const passed =
        Boolean(selected) &&
        (!expected || selected?.name === expected) &&
        (!testCase.expect.repository || selected?.repositoryId === testCase.expect.repository);
      return {
        id: testCase.id,
        passed,
        message: passed ? "matched" : `expected ${expected ?? "a result"}, got ${selected?.name ?? "none"}`,
        actual: results.map((item) => ({ name: item.artifact.name, score: item.score }))
      };
    }

    if (testCase.operation === "get") {
      const agent = snapshot.agents.find((item) => item.name === testCase.name);
      if (!agent) return { id: testCase.id, passed: false, message: "agent not found" };
      const passed =
        includesAll(agent.skills, testCase.expect.skills) &&
        includesAll(agent.prompts, testCase.expect.prompts) &&
        includesAll(agent.tools, testCase.expect.tools);
      return {
        id: testCase.id,
        passed,
        message: passed ? "bindings matched" : "agent bindings do not match expectations",
        actual: { skills: agent.skills, prompts: agent.prompts, tools: agent.tools }
      };
    }
    const candidates = snapshot.agents.filter(
      (item) => !testCase.client || item.compatibility[testCase.client] !== false
    );
    const results = searchArtifacts(testCase.query!, candidates, 5);
    const selected = results[0]?.artifact;
    const expected = testCase.expect.selected;
    const passed =
      Boolean(selected) &&
      (!expected || selected?.name === expected) &&
      (!testCase.expect.repository || selected?.repositoryId === testCase.expect.repository);
    return {
      id: testCase.id,
      passed,
      message: passed ? "matched" : `expected ${expected ?? "a result"}, got ${selected?.name ?? "none"}`,
      actual: results.map((item) => ({ name: item.artifact.name, score: item.score }))
    };
  } catch (error) {
    return {
      id: testCase.id,
      passed: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function runEvaluationSuite(
  snapshot: EvaluationSnapshot,
  suite: EvaluationSuite,
  baseline?: EvaluationRunResult
): EvaluationRunResult {
  const cases = suite.cases.map((testCase) => ({
    ...evaluateCase(testCase, snapshot),
    expected: testCase.expect
  }));
  const passed = cases.filter((item) => item.passed).length;
  const total = cases.length;
  const result: EvaluationRunResult = {
    runId: randomUUID(),
    ts: new Date().toISOString(),
    repositoryId: snapshot.repositoryId,
    revision: snapshot.revision,
    suiteId: suite.id,
    total,
    passed,
    failed: total - passed,
    passRate: total === 0 ? 0 : passed / total,
    cases
  };
  const retrieval = suite.cases
    .map((testCase, index) => ({ testCase, result: cases[index]! }))
    .filter((item) => item.testCase.target === "knowledge");
  if (retrieval.length > 0) {
    const ranks = retrieval.map((item) => item.result.rank);
    const count = retrieval.length;
    result.retrievalMetrics = {
      cases: count,
      hitAt1: ranks.filter((rank) => rank !== undefined && rank <= 1).length / count,
      hitAt3: ranks.filter((rank) => rank !== undefined && rank <= 3).length / count,
      hitAt5: ranks.filter((rank) => rank !== undefined && rank <= 5).length / count,
      mrr: ranks.reduce<number>((sum, rank) => sum + (rank === undefined ? 0 : 1 / rank), 0) / count
    };
  }
  if (baseline) {
    const candidateCaseIds = new Set(result.cases.map((item) => item.id));
    const removedBaselineCases = baseline.cases
      .filter((item) => item.passed && !candidateCaseIds.has(item.id))
      .map((item) => item.id);
    result.baselineRevision = baseline.revision;
    result.baselinePassed = baseline.passed;
    result.baselineRetrievalMetrics = baseline.retrievalMetrics;
    result.removedBaselineCases = removedBaselineCases;
    const retrievalRegression =
      Boolean(result.retrievalMetrics && baseline.retrievalMetrics) &&
      (result.retrievalMetrics!.hitAt1 < baseline.retrievalMetrics!.hitAt1 ||
        result.retrievalMetrics!.hitAt3 < baseline.retrievalMetrics!.hitAt3 ||
        result.retrievalMetrics!.hitAt5 < baseline.retrievalMetrics!.hitAt5 ||
        result.retrievalMetrics!.mrr < baseline.retrievalMetrics!.mrr);
    result.regression = result.passed < baseline.passed || removedBaselineCases.length > 0 || retrievalRegression;
  }
  return result;
}

export interface EvaluationGateThresholds {
  minPassRate?: number;
  warnPassRate?: number;
  minHitAt1?: number;
  warnHitAt1?: number;
  minHitAt3?: number;
  warnHitAt3?: number;
  minHitAt5?: number;
  warnHitAt5?: number;
  minMrr?: number;
  warnMrr?: number;
}

export interface EvaluationGateResult {
  ok: boolean;
  blockingReasons: string[];
  warnings: string[];
  metrics: {
    passRate: number;
    hitAt1?: number;
    hitAt3?: number;
    hitAt5?: number;
    mrr?: number;
  };
}

export function evaluateGate(
  runs: EvaluationRunResult[],
  thresholds: EvaluationGateThresholds = {},
  missingBaselineSuites: string[] = []
): EvaluationGateResult {
  const total = runs.reduce((sum, run) => sum + run.total, 0);
  const passed = runs.reduce((sum, run) => sum + run.passed, 0);
  const passRate = total ? passed / total : 0;
  const retrievalRuns = runs.filter((run) => run.retrievalMetrics && run.retrievalMetrics.cases > 0);
  const retrievalCases = retrievalRuns.reduce((sum, run) => sum + run.retrievalMetrics!.cases, 0);
  const weighted = (key: "hitAt1" | "hitAt3" | "hitAt5" | "mrr"): number | undefined =>
    retrievalCases
      ? retrievalRuns.reduce(
          (sum, run) => sum + run.retrievalMetrics![key] * run.retrievalMetrics!.cases,
          0
        ) / retrievalCases
      : undefined;
  const metrics = {
    passRate,
    hitAt1: weighted("hitAt1"),
    hitAt3: weighted("hitAt3"),
    hitAt5: weighted("hitAt5"),
    mrr: weighted("mrr")
  };
  const blockingReasons: string[] = [];
  const warnings: string[] = [];

  const check = (
    label: string,
    value: number | undefined,
    blocking: number | undefined,
    warning: number | undefined
  ) => {
    if (blocking !== undefined && value === undefined) {
      blockingReasons.push(label + " threshold configured but no metric was produced");
      return;
    }
    if (blocking !== undefined && value! < blocking) {
      blockingReasons.push(label + " " + value!.toFixed(4) + " < blocking threshold " + blocking.toFixed(4));
      return;
    }
    if (warning !== undefined && value === undefined) {
      warnings.push(label + " warning threshold configured but no metric was produced");
      return;
    }
    if (warning !== undefined && value! < warning) {
      warnings.push(label + " " + value!.toFixed(4) + " < warning threshold " + warning.toFixed(4));
    }
  };

  check("passRate", metrics.passRate, thresholds.minPassRate ?? 1, thresholds.warnPassRate);
  check("hitAt1", metrics.hitAt1, thresholds.minHitAt1, thresholds.warnHitAt1);
  check("hitAt3", metrics.hitAt3, thresholds.minHitAt3, thresholds.warnHitAt3);
  check("hitAt5", metrics.hitAt5, thresholds.minHitAt5, thresholds.warnHitAt5);
  check("mrr", metrics.mrr, thresholds.minMrr, thresholds.warnMrr);

  for (const run of runs) {
    if (run.regression) blockingReasons.push("baseline regression: " + run.suiteId);
  }
  for (const suite of missingBaselineSuites) {
    blockingReasons.push("baseline suite removed: " + suite);
  }
  return {
    ok: blockingReasons.length === 0,
    blockingReasons: [...new Set(blockingReasons)],
    warnings: [...new Set(warnings)],
    metrics
  };
}

export class EvaluationRunStore {
  constructor(
    private readonly dataDir: string,
    private readonly maxRuns = 1000
  ) {}

  private file(): string {
    return path.join(this.dataDir, "evaluations", "runs.jsonl");
  }

  async append(run: EvaluationRunResult): Promise<void> {
    await mkdir(path.dirname(this.file()), { recursive: true });
    await appendFile(this.file(), `${JSON.stringify(run)}\n`, "utf8");
    await this.compact();
  }

  private async compact(): Promise<void> {
    try {
      const rows = (await readFile(this.file(), "utf8")).split("\n").filter(Boolean);
      if (rows.length <= this.maxRuns) return;
      await writeFile(this.file(), `${rows.slice(-this.maxRuns).join("\n")}\n`, "utf8");
    } catch {
      // Evaluation persistence is best-effort and must not break evaluation itself.
    }
  }

  async list(limit = 100, repositoryId?: string, suiteId?: string): Promise<EvaluationRunResult[]> {
    try {
      const rows = (await readFile(this.file(), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as EvaluationRunResult)
        .filter((run) => !repositoryId || run.repositoryId === repositoryId)
        .filter((run) => !suiteId || run.suiteId === suiteId);
      return rows.slice(-Math.max(1, Math.min(limit, this.maxRuns))).reverse();
    } catch {
      return [];
    }
  }

  async get(runId: string): Promise<EvaluationRunResult | undefined> {
    return (await this.list(this.maxRuns)).find((run) => run.runId === runId);
  }
}
