import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN_MODULE_HTML, ADMIN_SKILL_BUNDLES_HTML } from "../src/admin-ui.js";

test("Skill Bundle admin page is an import flow that hands review to the unified center", () => {
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /导入 Skill Bundle/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /审核中心/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /Replacement Root/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /import_type/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /source_type/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /name="submission_mode"/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /value="merge"/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /value="replace"/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /submission_mode:mode/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /\/admin\/api\/skill-bundles\/preview/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /\/admin\/api\/skill-bundles\/import/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /\/admin\/review\/items\/skill-bundle\//);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /location\.assign/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /id="bundleTargetPath"/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /name="target_path"/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /collection-field/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /function updateImportFields\(\)/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /\.git-field/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /\.zip-field/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /\.files-field/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /previewButton\.disabled=true/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /importButton\.disabled=true/);
  assert.match(ADMIN_SKILL_BUNDLES_HTML, /finally/);
  assert.doesNotMatch(ADMIN_SKILL_BUNDLES_HTML, /data-view="pending"/);
});

test("unified review detail exposes Artifact Bundle state for Skill and Knowledge", () => {
  assert.match(ADMIN_MODULE_HTML, /Artifact Bundle ID/);
  assert.match(ADMIN_MODULE_HTML, /Submission Mode/);
  assert.match(ADMIN_MODULE_HTML, /Target Kind/);
  assert.match(ADMIN_MODULE_HTML, /Target Scope SHA256/);
  assert.match(ADMIN_MODULE_HTML, /Review Baseline SHA256/);
  assert.match(ADMIN_MODULE_HTML, /Snapshot SHA256/);
  assert.match(ADMIN_MODULE_HTML, /默认增量合并，未提交路径保持不变/);
  assert.match(ADMIN_MODULE_HTML, /显式替换目标 Scope/);
});
