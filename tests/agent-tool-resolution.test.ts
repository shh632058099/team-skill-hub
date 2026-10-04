import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentToolBindings } from "../src/artifacts.js";
import type { AgentArtifact, ToolArtifact } from "../src/types.js";

function tool(repositoryId: string, name: string, environments: string[]): ToolArtifact {
  return {
    key: repositoryId + ":" + name,
    schemaVersion: 1,
    name,
    description: name + " tool",
    repositoryId,
    revision: "r1",
    relativePath: "tools/" + name,
    type: "service",
    owner: "platform",
    audience: ["developer"],
    visibility: ["internal"],
    keywords: [name],
    environments,
    capabilities: ["query"],
    compatibility: {}
  };
}

function agent(tools: string[]): AgentArtifact {
  return {
    key: "rd-skills:ota-agent",
    schemaVersion: 1,
    name: "ota-agent",
    description: "OTA agent",
    repositoryId: "rd-skills",
    revision: "r1",
    relativePath: "agents/ota-agent",
    audience: ["developer"],
    visibility: ["internal"],
    keywords: ["ota"],
    owner: "ota-team",
    skills: [],
    prompts: [],
    tools,
    compatibility: {}
  };
}

test("agent tool resolution prefers same repository and checks environment", () => {
  const bindings = resolveAgentToolBindings(
    agent(["gitlab", "device-farm"]),
    [
      tool("shared-tools", "gitlab", ["dev", "prod"]),
      tool("rd-skills", "gitlab", ["dev", "prod"]),
      tool("rd-skills", "device-farm", ["lab"])
    ],
    "prod"
  );
  assert.equal(bindings[0]?.status, "resolved");
  assert.equal(bindings[0]?.tool?.repositoryId, "rd-skills");
  assert.equal(bindings[1]?.status, "environment-mismatch");
});

test("agent tool resolution requires qualification for ambiguous cross-repository tools", () => {
  const bindings = resolveAgentToolBindings(
    agent(["jenkins", "shared-tools:gitlab"]),
    [
      tool("shared-tools", "jenkins", ["dev"]),
      tool("release-tools", "jenkins", ["dev"]),
      tool("shared-tools", "gitlab", ["dev"])
    ],
    "dev"
  );
  assert.equal(bindings[0]?.status, "ambiguous");
  assert.equal(bindings[1]?.status, "resolved");
  assert.equal(bindings[1]?.tool?.key, "shared-tools:gitlab");
});
