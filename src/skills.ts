import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type {
  RepositoryConfig,
  Skill,
  SkillMetadata,
  ValidationIssue,
  ValidationRule
} from "./types.js";

interface Frontmatter {
  schema_version?: number;
  name?: string;
  version?: string;
  description?: string;
  metadata?: Partial<SkillMetadata> & { depends_on?: string[] };
}

function splitFrontmatter(content: string): { data: Frontmatter; body: string } {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    throw new Error("SKILL.md must start with YAML frontmatter");
  }
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error("Invalid YAML frontmatter boundary");
  return {
    data: YAML.parse(match[1]!) as Frontmatter,
    body: match[2]!
  };
}

async function findSkillFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name === "SKILL.md") result.push(full);
    }
  }
  await walk(root);
  return result.sort();
}

export async function scanSkills(
  root: string,
  repositoryId: string,
  revision: string
): Promise<Skill[]> {
  const files = await findSkillFiles(root);
  const skills: Skill[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const { data } = splitFrontmatter(content);
    const metadata = data.metadata ?? {};
    const relativePath = path.relative(root, path.dirname(file)).replaceAll("\\", "/");
    skills.push({
      key: `${repositoryId}:${data.name ?? relativePath}`,
      schemaVersion: data.schema_version ?? 1,
      name: data.name ?? "",
      version: data.version,
      description: data.description ?? "",
      repositoryId,
      revision,
      relativePath,
      rootDir: path.dirname(file),
      content,
      metadata: {
        audience: metadata.audience ?? [],
        domain: metadata.domain ?? [],
        category: metadata.category ?? [],
        keywords: metadata.keywords ?? [],
        product: metadata.product,
        visibility: metadata.visibility ?? [],
        maturity: metadata.maturity ?? "experimental",
        owner: metadata.owner ?? "",
        priority: metadata.priority ?? 50,
        dependsOn: metadata.depends_on ?? metadata.dependsOn ?? [],
        compatibility: metadata.compatibility ?? {}
      }
    });
  }
  return skills;
}

export class RequiredFieldsRule implements ValidationRule {
  readonly name = "required-fields";
  validate(skill: Skill): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (skill.schemaVersion !== 1) issues.push({ rule: this.name, message: "schema_version must be 1" });
    if (!skill.name) issues.push({ rule: this.name, message: "name is required" });
    if (!skill.description) issues.push({ rule: this.name, message: "description is required" });
    if (!skill.metadata.owner) issues.push({ rule: this.name, message: "metadata.owner is required" });
    for (const field of ["audience", "domain", "category", "keywords", "visibility"] as const) {
      if (skill.metadata[field].length === 0) {
        issues.push({ rule: this.name, message: `metadata.${field} must not be empty` });
      }
    }
    if (skill.metadata.priority < 0 || skill.metadata.priority > 100) {
      issues.push({ rule: this.name, message: "metadata.priority must be between 0 and 100" });
    }
    return issues;
  }
}

export class UniqueNameRule implements ValidationRule {
  readonly name = "unique-name";
  validate(skill: Skill, _repo: RepositoryConfig, allSkills: Skill[]): ValidationIssue[] {
    return allSkills.filter((item) => item.name === skill.name).length > 1
      ? [{ rule: this.name, message: `Duplicate skill name: ${skill.name}` }]
      : [];
  }
}

export class SkillDependencyRule implements ValidationRule {
  readonly name = "skill-dependency";

  validate(skill: Skill, repository: RepositoryConfig, allSkills: Skill[]): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const dependency of skill.metadata.dependsOn) {
      if (!/^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(dependency)) {
        issues.push({ rule: this.name, message: `Invalid dependency reference: ${dependency}` });
        continue;
      }
      const [repositoryId, skillName] = dependency.includes(":")
        ? dependency.split(":", 2)
        : [repository.id, dependency];
      if (repositoryId === repository.id && skillName === skill.name) {
        issues.push({ rule: this.name, message: "Skill cannot depend on itself" });
        continue;
      }
      if (
        repositoryId === repository.id &&
        !allSkills.some((candidate) => candidate.name === skillName)
      ) {
        issues.push({
          rule: this.name,
          message: `Missing same-repository dependency: ${dependency}`
        });
      }
    }
    return issues;
  }
}

export class RepositoryVisibilityRule implements ValidationRule {
  readonly name = "repository-visibility";
  validate(skill: Skill, repository: RepositoryConfig): ValidationIssue[] {
    const invalid = skill.metadata.visibility.filter(
      (visibility) => !repository.visibility.includes(visibility)
    );
    return invalid.length > 0
      ? [{
          rule: this.name,
          message: `Skill visibility exceeds repository visibility: ${invalid.join(", ")}`
        }]
      : [];
  }
}

export function validateSkills(
  skills: Skill[],
  repository: RepositoryConfig,
  rules: ValidationRule[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const skill of skills) {
    for (const rule of rules) {
      for (const issue of rule.validate(skill, repository, skills)) {
        issues.push({ ...issue, skillPath: skill.relativePath });
      }
    }
  }
  return issues;
}
