import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalArtifactTreeHash,
  diffArtifactTrees,
  planArtifactFinalTree,
  type ArtifactBundleFileInput,
} from "../src/artifact-bundles.js";

const text = (path: string, content: string, mode: "0644" | "0755" = "0644"): ArtifactBundleFileInput => ({
  path,
  content,
  mode,
});

test("merge_directory_preserves_omitted_files", () => {
  const before: ArtifactBundleFileInput[] = [
    text("SKILL.md", "# existing\n"),
    text("references/api.md", "api\n"),
    text("references/design.md", "design\n"),
    text("scripts/build.sh", "#!/bin/sh\necho build\n", "0755"),
    { path: "assets/diagram.png", contentBase64: Buffer.from([0, 1, 2, 255]).toString("base64"), mode: "0644" },
  ];
  const submitted = [text("references/new-api.md", "new api\n")];

  const finalTree = planArtifactFinalTree({
    targetKind: "directory",
    mode: "merge",
    before,
    submitted,
  });
  const diff = diffArtifactTrees(before, finalTree);

  assert.equal(finalTree.length, 6);
  assert.deepEqual(diff.added, ["references/new-api.md"]);
  assert.deepEqual(diff.modified, []);
  assert.deepEqual(diff.deleted, []);
  for (const original of before) {
    const retained = finalTree.find((file) => file.path === original.path);
    assert.ok(retained, original.path);
    assert.equal(retained.mode, original.mode);
    assert.equal(
      retained.sha256,
      planArtifactFinalTree({
        targetKind: "directory",
        mode: "merge",
        before: [original],
        submitted: [],
      })[0]?.sha256,
    );
  }
});

test("merge_directory_adds_and_overwrites_only_submitted_paths", () => {
  const before = [text("SKILL.md", "old"), text("references/a.md", "keep")];
  const finalTree = planArtifactFinalTree({
    targetKind: "directory",
    mode: "merge",
    before,
    submitted: [text("SKILL.md", "new"), text("references/b.md", "added")],
  });
  const diff = diffArtifactTrees(before, finalTree);
  assert.deepEqual(diff.added, ["references/b.md"]);
  assert.deepEqual(diff.modified, ["SKILL.md"]);
  assert.deepEqual(diff.deleted, []);
  assert.equal(finalTree.find((file) => file.path === "references/a.md")?.content, "keep");
});

test("replace_directory_deletes_omitted_files", () => {
  const before = [text("SKILL.md", "old"), text("references/a.md", "old ref")];
  const finalTree = planArtifactFinalTree({
    targetKind: "directory",
    mode: "replace",
    before,
    submitted: [text("SKILL.md", "new")],
  });
  const diff = diffArtifactTrees(before, finalTree);
  assert.deepEqual(diff.modified, ["SKILL.md"]);
  assert.deepEqual(diff.deleted, ["references/a.md"]);
});

test("file_scope_merge_and_replace_touch_only_one_entry", () => {
  const before = [text("target.md", "old")];
  for (const mode of ["merge", "replace"] as const) {
    const finalTree = planArtifactFinalTree({
      targetKind: "file",
      mode,
      before,
      submitted: [text("target.md", "new")],
    });
    assert.deepEqual(
      finalTree.map((file) => file.path),
      ["target.md"],
    );
    assert.equal(finalTree[0]?.content, "new");
  }
  assert.throws(
    () =>
      planArtifactFinalTree({
        targetKind: "file",
        mode: "merge",
        before,
        submitted: [text("target.md", "new"), text("sibling.md", "must not be in file scope")],
      }),
    /file-scoped artifact/i,
  );
});
test("merge_preserves_binary_bytes_and_execute_mode", () => {
  const binary = Buffer.from([0, 255, 16, 32]).toString("base64");
  const before: ArtifactBundleFileInput[] = [
    { path: "assets/blob.bin", contentBase64: binary, mode: "0644" },
    text("scripts/run.sh", "#!/bin/sh\n", "0755"),
  ];
  const finalTree = planArtifactFinalTree({
    targetKind: "directory",
    mode: "merge",
    before,
    submitted: [text("notes/new.md", "new")],
  });
  const blob = finalTree.find((file) => file.path === "assets/blob.bin");
  const script = finalTree.find((file) => file.path === "scripts/run.sh");
  assert.equal(blob?.contentBase64, binary);
  assert.equal(blob?.mode, "0644");
  assert.equal(script?.content, "#!/bin/sh\n");
  assert.equal(script?.mode, "0755");
});

test("canonical_hash_is_stable_for_sorted_equivalent_trees", () => {
  const files = [text("b.md", "b"), text("a.md", "a")];
  assert.equal(canonicalArtifactTreeHash(files), canonicalArtifactTreeHash([...files].reverse()));
  assert.notEqual(
    canonicalArtifactTreeHash(files),
    canonicalArtifactTreeHash([text("b.md", "changed"), text("a.md", "a")]),
  );
});

test("case_collisions_and_invalid_paths_are_rejected", () => {
  assert.throws(
    () =>
      planArtifactFinalTree({
        targetKind: "directory",
        mode: "merge",
        before: [],
        submitted: [text("A.md", "a"), text("a.md", "b")],
      }),
    /case collision/i,
  );
  for (const path of ["../escape", "/absolute", "C:/drive", "bad\\path"]) {
    assert.throws(
      () =>
        planArtifactFinalTree({
          targetKind: "directory",
          mode: "merge",
          before: [],
          submitted: [text(path, "x")],
        }),
      /path/i,
    );
  }
});
