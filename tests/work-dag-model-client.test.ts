import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HttpWorkDagPlannerModel,
  createConfiguredWorkDagPlanner,
  loadWorkDagPlannerConfig,
} from "../src/expert-platform/work-dag-model-client.js";

test("responses planner client resolves credential ref without persisting secret and extracts output text", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  let seenBody: any;
  const model = new HttpWorkDagPlannerModel({
    config: {
      providerId: "router",
      model: "gpt-test",
      baseUrl: "https://router.example/v1",
      wireApi: "responses",
      credentialRef: "planner",
      allowedEnvNames: ["PLANNER_API_KEY"],
    },
    credentialEnvNames: { planner: "PLANNER_API_KEY" },
    env: { PLANNER_API_KEY: "secret-token" },
    fetchImpl: async (url, init) => {
      seenUrl = String(url);
      seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      seenBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          output: [{ type: "message", content: [{ type: "output_text", text: '{"nodes":[],"edges":[]}' }] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const text = await model.complete({ system: "system", payload: { work: { id: "w" } } });
  assert.equal(text, '{"nodes":[],"edges":[]}');
  assert.equal(seenUrl, "https://router.example/v1/responses");
  assert.equal(seenHeaders.authorization, "Bearer secret-token");
  assert.equal(seenBody.model, "gpt-test");
  assert.equal(seenBody.tools, undefined);
  assert.match(JSON.stringify(seenBody.input), /"system"/);
  assert.equal(JSON.parse(seenBody.input[1].content[0].text).work.id, "w");
  assert.doesNotMatch(JSON.stringify(seenBody), /secret-token/);
});

test("planner HTTP client forwards cancellation signal to fetch", async () => {
  let observed: AbortSignal | null | undefined;
  const model = new HttpWorkDagPlannerModel({
    config: {
      providerId: "router",
      model: "gpt-test",
      baseUrl: "https://router.example/v1",
      wireApi: "responses",
      allowedEnvNames: ["PLANNER_API_KEY"],
    },
    env: { PLANNER_API_KEY: "secret-token" },
    fetchImpl: async (_url, init) => {
      observed = init?.signal;
      return new Response(JSON.stringify({ output_text: '{"nodes":[],"edges":[]}' }), { status: 200 });
    },
  });
  const controller = new AbortController();
  await model.complete({ system: "system", payload: {} }, controller.signal);
  assert.equal(observed, controller.signal);
});

test("anthropic planner client uses messages API and no tools", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  let seenBody: any;
  const model = new HttpWorkDagPlannerModel({
    config: {
      providerId: "anthropic-router",
      model: "claude-test",
      baseUrl: "https://claude.example/v1",
      wireApi: "anthropic-messages",
      allowedEnvNames: ["ANTHROPIC_API_KEY"],
    },
    env: { ANTHROPIC_API_KEY: "anthropic-secret" },
    fetchImpl: async (url, init) => {
      seenUrl = String(url);
      seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: '{"nodes":[],"edges":[]}' }] }), {
        status: 200,
      });
    },
  });
  assert.equal(await model.complete({ system: "s", payload: { x: 1 } }), '{"nodes":[],"edges":[]}');
  assert.equal(seenUrl, "https://claude.example/v1/messages");
  assert.equal(seenHeaders["x-api-key"], "anthropic-secret");
  assert.equal(seenHeaders["anthropic-version"], "2023-06-01");
  assert.equal(seenBody.tools, undefined);
});

test("planner client fails closed on missing credential, oversized output and HTTP errors without leaking body", async () => {
  const base = {
    config: {
      providerId: "r",
      model: "m",
      baseUrl: "https://r.example/v1",
      wireApi: "responses" as const,
      credentialRef: "p",
      allowedEnvNames: ["KEY"],
    },
    credentialEnvNames: { p: "KEY" },
  };
  await assert.rejects(
    () => new HttpWorkDagPlannerModel({ ...base, env: {} }).complete({ system: "s", payload: {} }),
    /PLANNER_CREDENTIAL_NOT_CONFIGURED/,
  );
  await assert.rejects(
    () =>
      new HttpWorkDagPlannerModel({
        ...base,
        env: { KEY: "k" },
        maxResponseBytes: 1024,
        fetchImpl: async () => new Response(JSON.stringify({ output_text: "x".repeat(2000) }), { status: 200 }),
      }).complete({ system: "s", payload: {} }),
    /PLANNER_MODEL_OUTPUT_TOO_LARGE/,
  );
  await assert.rejects(
    () =>
      new HttpWorkDagPlannerModel({
        ...base,
        env: { KEY: "k" },
        fetchImpl: async () => new Response("very-secret-upstream-error", { status: 503 }),
      }).complete({ system: "s", payload: {} }),
    /PLANNER_MODEL_HTTP_503/,
  );
});

test("planner env loader is optional, validates safe config and returns bounded timeout", () => {
  assert.equal(loadWorkDagPlannerConfig({}), null);
  const loaded = loadWorkDagPlannerConfig({
    EXPERT_WORK_DAG_PLANNER_MODEL_CONFIG_JSON: JSON.stringify({
      providerId: "router",
      model: "planner",
      baseUrl: "https://router.example/v1",
      wireApi: "responses",
      credentialRef: "planner",
      allowedEnvNames: ["PLANNER_KEY"],
    }),
    EXPERT_WORK_DAG_PLANNER_CREDENTIAL_REFS_JSON: JSON.stringify({ planner: "PLANNER_KEY" }),
    EXPERT_WORK_DAG_PLANNER_TIMEOUT_MS: "12000",
  });
  assert.ok(loaded);
  assert.equal(loaded.timeoutMs, 12000);
  assert.equal(loaded.config.model, "planner");
  assert.deepEqual(loaded.credentialEnvNames, { planner: "PLANNER_KEY" });
  const configured = createConfiguredWorkDagPlanner(
    {
      EXPERT_WORK_DAG_PLANNER_MODEL_CONFIG_JSON: JSON.stringify({
        providerId: "router",
        model: "planner",
        baseUrl: "https://router.example/v1",
        wireApi: "responses",
        credentialRef: "planner",
        allowedEnvNames: ["PLANNER_KEY"],
      }),
      EXPERT_WORK_DAG_PLANNER_CREDENTIAL_REFS_JSON: JSON.stringify({ planner: "PLANNER_KEY" }),
      EXPERT_WORK_DAG_PLANNER_TIMEOUT_MS: "12000",
      PLANNER_KEY: "secret",
    },
    async () => new Response(JSON.stringify({ output_text: '{"nodes":[],"edges":[]}' }), { status: 200 }),
  );
  assert.ok(configured);
  assert.equal(configured.timeoutMs, 12000);
  assert.equal(configured.planner.identity, "llm:router:planner");
  assert.match(configured.planner.version, /^[a-f0-9]{16}$/);
  assert.throws(
    () =>
      loadWorkDagPlannerConfig({
        EXPERT_WORK_DAG_PLANNER_MODEL_CONFIG_JSON: '{"providerId":"x"}',
      }),
    /INVALID_WORK_DAG_PLANNER_CONFIG/,
  );
  assert.throws(
    () =>
      loadWorkDagPlannerConfig({
        EXPERT_WORK_DAG_PLANNER_MODEL_CONFIG_JSON: JSON.stringify({
          providerId: "r",
          model: "m",
          baseUrl: "https://r.example/v1?token=x",
          wireApi: "responses",
          allowedEnvNames: ["KEY"],
        }),
      }),
    /INVALID_WORK_DAG_PLANNER_CONFIG/,
  );
});
