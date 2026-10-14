import assert from "node:assert/strict";
import { Script } from "node:vm";
import test from "node:test";

import {
  ADMIN_GOVERNANCE_HTML,
  ADMIN_HTML,
  ADMIN_LOGIN_HTML,
  ADMIN_MODULE_HTML,
  ADMIN_MODULE_INDEX_HTML,
  ADMIN_OBSERVABILITY_HTML,
  ADMIN_OBSERVABILITY_INDEX_HTML,
} from "../src/admin-ui.js";

const pages = {
  ADMIN_GOVERNANCE_HTML,
  ADMIN_HTML,
  ADMIN_LOGIN_HTML,
  ADMIN_OBSERVABILITY_INDEX_HTML,
  ADMIN_OBSERVABILITY_HTML,
  ADMIN_MODULE_INDEX_HTML,
  ADMIN_MODULE_HTML,
};

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1] ?? "");
}

test("admin HTML inline scripts are valid JavaScript", () => {
  for (const [name, html] of Object.entries(pages)) {
    const scripts = inlineScripts(html);
    assert.ok(scripts.length > 0, `${name} should contain at least one inline script`);
    for (const [index, script] of scripts.entries()) {
      assert.doesNotThrow(
        () => new Script(script, { filename: `${name}-inline-${index + 1}.js` }),
        `${name} inline script ${index + 1} should parse`,
      );
    }
  }
});
