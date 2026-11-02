import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("Expert gRPC host publish bind is controlled consistently by EXPERT_GRPC_PUBLISH_BIND", () => {
  const main = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  const expert = readFileSync(path.join(root, "docker-compose.expert.yml"), "utf8");

  const binding = '"${EXPERT_GRPC_PUBLISH_BIND:-127.0.0.1}:7443:7443"';
  assert.match(main, new RegExp(binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(expert, new RegExp(binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(main, /"127\.0\.0\.1:7443:7443"/);
});
