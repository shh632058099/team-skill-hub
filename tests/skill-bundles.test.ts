import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalTreeHash,
  diffSkillBundleTrees,
  legacyRdSkillPathToTarget,
  normalizeSkillBundleInput
} from "../src/skill-bundles.js";

test("skill import normalizes a safe replacement root and one root SKILL.md", () => {
  const result = normalizeSkillBundleInput({
    namespace: "ota",
    importType: "skill",
    skillPath: "design",
    files: [
      { path: "SKILL.md", content: "skill" },
      { path: "scripts/check.sh", content: "#!/bin/sh\n", mode: "0755" }
    ]
  });
  assert.equal(result.replacementRoot, "skills/ota/design");
  assert.equal(result.files[0]?.mode, "0644");
  assert.equal(result.files[1]?.mode, "0755");
  assert.deepEqual(result.skills.map((item) => item.rootPath), [""]);
});

test("skill import can target a top-level skill root without a nested skill_path", () => {
  const result = normalizeSkillBundleInput({
    namespace: "skill-creator",
    importType: "skill",
    files: [{ path: "SKILL.md", content: "skill" }]
  });
  assert.equal(result.skillPath, undefined);
  assert.equal(result.replacementRoot, "skills/skill-creator");
});

test("skill import rejects nested or multiple SKILL.md files", () => {
  assert.throws(() => normalizeSkillBundleInput({
    namespace: "ota",
    importType: "skill",
    skillPath: "design",
    files: [
      { path: "SKILL.md", content: "one" },
      { path: "nested/SKILL.md", content: "two" }
    ]
  }), /exactly one root SKILL\.md/i);
});

test("collection rejects ancestor-descendant nested skill roots", () => {
  assert.throws(() => normalizeSkillBundleInput({
    namespace: "ota",
    importType: "collection",
    files: [
      { path: "design/SKILL.md", content: "one" },
      { path: "design/internal/SKILL.md", content: "two" }
    ]
  }), /nested skill roots/i);
});

test("normalization rejects traversal, absolute paths and case collisions", () => {
  for (const skillPath of ["../design", "/design", "C:/design", "design\\escape"]) {
    assert.throws(() => normalizeSkillBundleInput({
      namespace: "ota",
      importType: "skill",
      skillPath,
      files: [{ path: "SKILL.md", content: "x" }]
    }), /skill_path/i);
  }
  assert.throws(() => normalizeSkillBundleInput({
    namespace: "ota",
    importType: "collection",
    files: [
      { path: "Design/SKILL.md", content: "a" },
      { path: "design/skill.md", content: "b" }
    ]
  }), /case collision/i);
});

test("canonical tree hash is order independent but includes mode and exact bytes", () => {
  const a = [
    { path: "b.txt", content: "b\n", mode: "0644" as const },
    { path: "a.sh", content: "a\r\n", mode: "0755" as const }
  ];
  const b = [...a].reverse();
  assert.equal(canonicalTreeHash(a), canonicalTreeHash(b));
  assert.notEqual(canonicalTreeHash(a), canonicalTreeHash([{ ...a[0]! }, { ...a[1]!, mode: "0644" }]));
  assert.notEqual(canonicalTreeHash(a), canonicalTreeHash([{ ...a[0]! }, { ...a[1]!, content: "a\n" }]));
});

test("diff reports only paths inside the supplied replacement tree", () => {
  const diff = diffSkillBundleTrees(
    [
      { path: "SKILL.md", content: "old", mode: "0644" },
      { path: "old.txt", content: "gone", mode: "0644" }
    ],
    [
      { path: "SKILL.md", content: "new", mode: "0644" },
      { path: "new.txt", content: "added", mode: "0644" }
    ]
  );
  assert.deepEqual(diff.added, ["new.txt"]);
  assert.deepEqual(diff.modified, ["SKILL.md"]);
  assert.deepEqual(diff.deleted, ["old.txt"]);
});

test("legacy rd-skills path maps only unambiguous skill paths", () => {
  assert.deepEqual(legacyRdSkillPathToTarget("ota/design/SKILL.md"), {
    namespace: "ota",
    skillPath: "design",
    replacementRoot: "skills/ota/design"
  });
  assert.deepEqual(legacyRdSkillPathToTarget("skills/ota/design/SKILL.md"), {
    namespace: "ota",
    skillPath: "design",
    replacementRoot: "skills/ota/design"
  });
  assert.equal(legacyRdSkillPathToTarget("ota/SKILL.md"), undefined);
});

test("central normalizer enforces Bundle file, total byte and Skill-count limits", () => {
  assert.throws(() => normalizeSkillBundleInput({
    namespace: "ota",
    importType: "skill",
    skillPath: "design",
    files: [{ path: "SKILL.md", content: "x".repeat(512 * 1024 + 1) }]
  }), /single file size limit/i);

  assert.throws(() => normalizeSkillBundleInput({
    namespace: "ota",
    importType: "collection",
    files: Array.from({ length: 501 }, (_, index) => ({
      path: `skill-${index}/SKILL.md`,
      content: `skill-${index}`
    }))
  }), /file count limit/i);

  assert.throws(() => normalizeSkillBundleInput({
    namespace: "ota",
    importType: "collection",
    files: Array.from({ length: 101 }, (_, index) => ({
      path: `skill-${index}/SKILL.md`,
      content: `skill-${index}`
    }))
  }), /skill count limit/i);

  assert.throws(() => normalizeSkillBundleInput({
    namespace: "ota",
    importType: "collection",
    files: Array.from({ length: 21 }, (_, index) => ({
      path: `skill-${index}/SKILL.md`,
      content: "x".repeat(512 * 1024)
    }))
  }), /total size limit/i);
});

test("skill summaries expose frontmatter names without becoming a second validator", () => {
  const normalized = normalizeSkillBundleInput({
    namespace: "ota",
    importType: "skill",
    skillPath: "design",
    files: [{ path: "SKILL.md", content: "---\nname: ota-design\n---\n\n# body\n" }]
  });
  assert.equal(normalized.skills[0]?.name, "ota-design");
});
