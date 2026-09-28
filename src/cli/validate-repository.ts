import path from "node:path";
import {
  RequiredFieldsRule,
  RepositoryVisibilityRule,
  SkillDependencyRule,
  UniqueNameRule,
  scanSkills,
  validateSkills
} from "../skills.js";
import type { RepositoryConfig } from "../types.js";
import { scanAgents, scanPrompts, validateArtifactPolicies } from "../artifacts.js";
import { scanEvaluationSuites } from "../evaluation.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const repositoryPath = arg("--path");
if (!repositoryPath) {
  console.error("Usage: npm run validate:repo -- --path <repo> [--id <id>] [--visibility internal,customer]");
  process.exit(2);
}

const id = arg("--id") ?? path.basename(path.resolve(repositoryPath));
const visibility = (arg("--visibility") ?? "internal")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const repository: RepositoryConfig = {
  id,
  name: id,
  provider: "local",
  gitAuth: { type: "none" },
  webhookAliases: [],
  path: path.resolve(repositoryPath),
  enabled: true,
  audience: ["developer", "customer", "fae"],
  visibility,
  pollingIntervalSeconds: 0,
  readRoles: [],
  syncRoles: []
};

try {
  const skills = await scanSkills(repository.path!, repository.id, "validation");
  const prompts = await scanPrompts(repository.path!, repository.id, "validation");
  const agents = await scanAgents(repository.path!, repository.id, "validation");
  const evaluationSuites = await scanEvaluationSuites(repository.path!, repository.id);
  const issues = validateSkills(skills, repository, [
    new RequiredFieldsRule(),
    new UniqueNameRule(),
    new SkillDependencyRule(),
    new RepositoryVisibilityRule()
  ]);
  const artifactIssues = validateArtifactPolicies(
    repository,
    prompts,
    agents,
    skills.map((skill) => skill.name)
  );
  for (const message of artifactIssues) {
    issues.push({ rule: "artifact", message });
  }
  if (skills.length === 0) {
    issues.push({ rule: "repository", message: "Repository contains no SKILL.md" });
  }
  if (issues.length > 0) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          repository: id,
          skillCount: skills.length,
          promptCount: prompts.length,
          agentCount: agents.length,
          evaluationSuiteCount: evaluationSuites.length,
          issues
        },
        null,
        2
      )
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        repository: id,
        skillCount: skills.length,
        promptCount: prompts.length,
        agentCount: agents.length
        ,evaluationSuiteCount: evaluationSuites.length
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        repository: id,
        error: error instanceof Error ? error.message : String(error)
      },
      null,
      2
    )
  );
  process.exit(1);
}
