import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { Readable } from "node:stream";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as skillBundleSources from "../src/skill-bundle-sources.js";
import {
  buildSkillBundleGitCurlResolve,
  buildSkillBundleGitEnvironment,
  extractSkillBundleZip,
  selectSkillBundleFiles,
  validateSkillBundleGitUrl,
} from "../src/skill-bundle-sources.js";

test("ZIP source_root strips packaging root and preserves trusted executable bit", async () => {
  const zip = new JSZip();
  zip.file("repo/design/SKILL.md", "skill\n", { unixPermissions: 0o100644 });
  zip.file("repo/design/scripts/run.sh", "#!/bin/sh\n", { unixPermissions: 0o100755 });
  const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
  const files = await extractSkillBundleZip(bytes.toString("base64"), "repo/design");
  assert.deepEqual(
    files.map((x) => [x.path, x.mode]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ["scripts/run.sh", "0755"],
      ["SKILL.md", "0644"],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
});

test("ZIP import rejects traversal roots but preserves binary assets as base64", async () => {
  const zip = new JSZip();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  zip.file("repo/SKILL.md", "---\nname: demo\n---\n\n# Demo\n");
  zip.file("repo/assets/demo.png", png);
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  await assert.rejects(() => extractSkillBundleZip(bytes.toString("base64"), "../repo"), /source_root/i);
  const files = await extractSkillBundleZip(bytes.toString("base64"), "repo");
  const asset = files.find((file) => file.path === "assets/demo.png");
  assert.equal(asset?.contentBase64, png.toString("base64"));
  assert.equal(asset?.content, undefined);
});

test("ZIP import still requires SKILL.md itself to be UTF-8 text", async () => {
  const zip = new JSZip();
  zip.file("repo/SKILL.md", Buffer.from([0, 1, 2]));
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  await assert.rejects(
    () => extractSkillBundleZip(bytes.toString("base64"), "repo"),
    /SKILL\.md.*UTF-8|UTF-8.*SKILL\.md/i,
  );
});

test("ZIP entries are size-limited while streaming instead of materialized with async", async () => {
  const originalLoadAsync = (JSZip as any).loadAsync;
  (JSZip as any).loadAsync = async () => ({
    files: {
      "repo/SKILL.md": {
        dir: false,
        unixPermissions: 0o100644,
        async: async () => {
          throw new Error("entry.async must not be used");
        },
        nodeStream: () => Readable.from([Buffer.alloc(300 * 1024, 0x61), Buffer.alloc(300 * 1024, 0x61)]),
      },
    },
  });
  try {
    await assert.rejects(
      () => extractSkillBundleZip(Buffer.from("fake zip").toString("base64"), "repo"),
      /file exceeds size limit/i,
    );
  } finally {
    (JSZip as any).loadAsync = originalLoadAsync;
  }
});

test("Git URL validation requires https allowlist and rejects credentials/private addresses", async () => {
  const resolve = async (host: string) => (host === "github.com" ? ["140.82.112.4"] : ["127.0.0.1"]);
  const validated = (await validateSkillBundleGitUrl(
    "https://github.com/example/repo.git",
    ["github.com"],
    resolve,
  )) as any;
  assert.equal(validated.url?.hostname, "github.com");
  assert.deepEqual(validated.addresses, ["140.82.112.4"]);
  await assert.rejects(
    () => validateSkillBundleGitUrl("ssh://github.com/example/repo.git", ["github.com"], resolve),
    /https/i,
  );
  await assert.rejects(
    () => validateSkillBundleGitUrl("https://user:pass@github.com/example/repo.git", ["github.com"], resolve),
    /credentials/i,
  );
  await assert.rejects(
    () => validateSkillBundleGitUrl("https://internal.example/repo.git", ["internal.example"], resolve),
    /private|loopback/i,
  );
  await assert.rejects(
    () =>
      validateSkillBundleGitUrl("https://mapped.example/repo.git", ["mapped.example"], async () => [
        "::ffff:127.0.0.1",
      ]),
    /private|loopback|link-local/i,
  );
});

test("Git curl resolve binding uses the actual HTTPS port and brackets IPv6 addresses", () => {
  assert.equal(
    buildSkillBundleGitCurlResolve(new URL("https://git.example:8443/org/repo.git"), [
      "203.0.113.10",
      "2001:4860:4860::8888",
    ]),
    "git.example:8443:203.0.113.10,[2001:4860:4860::8888]",
  );
});

test("Git source environment bypasses inherited proxies for the validated source host", () => {
  const env = buildSkillBundleGitEnvironment(
    { HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "localhost" },
    "git.example",
  );
  assert.equal(env.HTTPS_PROXY, "http://proxy.example:8080");
  assert.match(String(env.NO_PROXY), /(?:^|,)git\.example(?:,|$)/);
  assert.match(String(env.no_proxy), /(?:^|,)git\.example(?:,|$)/);
});

test("Git command quota monitor kills a clone-like process while it exceeds temporary disk limit", async () => {
  const runWithQuota = (skillBundleSources as any).runGitCommandWithDirectoryQuota;
  assert.equal(typeof runWithQuota, "function");
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-git-quota-"));
  const monitored = path.join(root, "repo");
  await mkdir(monitored, { recursive: true });
  const script = path.join(root, "fake-git.sh");
  await writeFile(
    script,
    `#!/bin/sh\ndd if=/dev/zero of="$1/payload" bs=1048576 count=2 status=none\nsleep 5\n`,
    "utf8",
  );
  await chmod(script, 0o755);
  try {
    const started = Date.now();
    await assert.rejects(
      () =>
        runWithQuota({
          executable: script,
          args: [monitored],
          cwd: root,
          monitorRoot: monitored,
          timeoutMs: 5000,
          maxBytes: 1024 * 1024,
          pollIntervalMs: 20,
        }),
      /temporary disk usage exceeds limit/i,
    );
    assert.ok(
      Date.now() - started < 1500,
      "quota termination should not wait for descendant processes to exit naturally",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git source file reader rejects an oversized file before reading its contents", async () => {
  const readTextFile = (skillBundleSources as any).readSkillBundleTextFile;
  assert.equal(typeof readTextFile, "function");
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-git-file-limit-"));
  const file = path.join(root, "large.txt");
  try {
    await writeFile(file, Buffer.alloc(513 * 1024, 0x61));
    await assert.rejects(() => readTextFile(file, "large.txt", 0o644), /file exceeds size limit/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("implicit source selection strips one skill root and excludes unrelated repository files", () => {
  const files = [
    { path: "README.md", content: "repo" },
    { path: ".github/workflows/ci.yml", content: "ci" },
    { path: "skills/design/SKILL.md", content: "design" },
    { path: "skills/design/references/a.md", content: "a" },
  ];
  assert.deepEqual(
    new Set(selectSkillBundleFiles(files, "skill").map((item) => item.path)),
    new Set(["SKILL.md", "references/a.md"]),
  );
});

test("implicit collection source selection strips a common packaging root and keeps only skill roots", () => {
  const files = [
    { path: "repo/README.md", content: "repo" },
    { path: "repo/design/SKILL.md", content: "design" },
    { path: "repo/design/a.md", content: "a" },
    { path: "repo/usage/SKILL.md", content: "usage" },
    { path: "repo/docs/unrelated.md", content: "docs" },
  ];
  assert.deepEqual(
    new Set(selectSkillBundleFiles(files, "collection").map((item) => item.path)),
    new Set(["design/SKILL.md", "design/a.md", "usage/SKILL.md"]),
  );
});

test("implicit skill source selection rejects multiple possible skill roots", () => {
  assert.throws(
    () =>
      selectSkillBundleFiles(
        [
          { path: "design/SKILL.md", content: "design" },
          { path: "usage/SKILL.md", content: "usage" },
        ],
        "skill",
      ),
    /source_root/i,
  );
});
