import test from "node:test";
import assert from "node:assert/strict";
import { buildArtifactFileActions, type ArtifactFileAction } from "../src/artifact-bundle-publishing.js";
import type { ArtifactBundleFileInput } from "../src/artifact-bundles.js";

const text = (path: string, content: string, mode: "0644" | "0755" = "0644"): ArtifactBundleFileInput => ({
  path,
  content,
  mode,
});

const summarize = (actions: ArtifactFileAction[]) => actions.map((action) => [action.action, action.path]);

test("merge_action_plan_has_no_delete_for_omitted_file", () => {
  const before = [text("SKILL.md", "old"), text("references/keep.md", "keep")];
  const finalTree = [text("SKILL.md", "old"), text("references/keep.md", "keep"), text("references/new.md", "new")];
  assert.deepEqual(summarize(buildArtifactFileActions(before, finalTree)), [["create", "references/new.md"]]);
});

test("replace_directory_action_plan_deletes_only_omitted_paths", () => {
  const before = [text("SKILL.md", "old"), text("references/old.md", "old")];
  const finalTree = [text("SKILL.md", "new")];
  assert.deepEqual(summarize(buildArtifactFileActions(before, finalTree)), [
    ["update", "SKILL.md"],
    ["delete", "references/old.md"],
  ]);
});

test("file_scope_replace_has_no_sibling_delete", () => {
  const before = [text("target.md", "old")];
  const finalTree = [text("target.md", "new")];
  assert.deepEqual(summarize(buildArtifactFileActions(before, finalTree)), [["update", "target.md"]]);
});

test("mixed action plan writes before deletes", () => {
  const before = [text("SKILL.md", "old"), text("old.txt", "old")];
  const finalTree = [text("SKILL.md", "new"), text("scripts/run.sh", "#!/bin/sh\n", "0755")];
  assert.deepEqual(summarize(buildArtifactFileActions(before, finalTree)), [
    ["update", "SKILL.md"],
    ["create", "scripts/run.sh"],
    ["chmod", "scripts/run.sh"],
    ["delete", "old.txt"],
  ]);
});

test("mode_only_change_emits_chmod", () => {
  const before = [text("scripts/run.sh", "#!/bin/sh\n", "0644")];
  const finalTree = [text("scripts/run.sh", "#!/bin/sh\n", "0755")];
  assert.deepEqual(summarize(buildArtifactFileActions(before, finalTree)), [["chmod", "scripts/run.sh"]]);
});
