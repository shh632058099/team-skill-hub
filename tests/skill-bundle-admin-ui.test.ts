import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN_SKILL_BUNDLES_HTML } from "../src/admin-ui.js";

test("Skill Bundle admin page exposes import, review/history and replacement boundary", () => {
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /导入 Skill Bundle/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /Pending Review|待审核/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /History|历史/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /Replacement Root/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /import_type/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /source_type/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /published_drifted/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /\/admin\/api\/skill-bundles\/preview/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /\/admin\/api\/skill-bundles\/import/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /id="bundleTargetPath"/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /name="target_path"/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /target_path/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /collection-field/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /function updateImportFields\(\)/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /\.git-field/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /\.zip-field/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /\.files-field/);
});
