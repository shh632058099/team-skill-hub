import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { auditKnowledgeLifecycle, chunksForDocuments, KnowledgeIndex, scanKnowledge } from "../src/knowledge.js";

test("knowledge scanner indexes markdown and text but excludes skill manifests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-knowledge-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await mkdir(path.join(root, "ota"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "ota-recovery.md"),
      "# OTA 断电恢复\n\n升级过程中断电后，设备通过恢复状态机回到最后一个安全检查点。\n\n回滚逻辑会验证镜像版本和完整性。\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "docs", "notes.txt"),
      "Production troubleshooting notes for firmware update rollback.",
      "utf8"
    );
    await writeFile(
      path.join(root, "ota", "SKILL.md"),
      "# should not be indexed as generic knowledge",
      "utf8"
    );

    const documents = await scanKnowledge(root, "rd-skills", "rev-1");
    assert.deepEqual(
      documents.map((document) => document.relativePath),
      ["docs/notes.txt", "docs/ota-recovery.md"]
    );
    assert.equal(documents.find((item) => item.relativePath === "docs/ota-recovery.md")?.title, "OTA 断电恢复");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge source configuration controls include exclude and chunking", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-knowledge-config-"));
  try {
    await mkdir(path.join(root, "docs", "private"), { recursive: true });
    await mkdir(path.join(root, "archive"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Root\n\nRoot knowledge.", "utf8");
    await writeFile(
      path.join(root, "docs", "guide.md"),
      "# Guide\n\n" + "Recovery checkpoint details. ".repeat(80),
      "utf8"
    );
    await writeFile(path.join(root, "docs", "private", "secret.md"), "# Secret\n\nHidden.", "utf8");
    await writeFile(path.join(root, "archive", "old.md"), "# Old\n\nArchived.", "utf8");

    const documents = await scanKnowledge(root, "rd-skills", "rev-config", {
      enabled: true,
      include: ["README.md", "docs/**"],
      exclude: ["docs/private/**"],
      maxDocumentBytes: 1024 * 1024,
      chunkSizeChars: 300,
      chunkOverlapChars: 40
    });

    assert.deepEqual(
      documents.map((item) => item.relativePath),
      ["README.md", "docs/guide.md"]
    );
    const guide = documents.find((item) => item.relativePath === "docs/guide.md");
    assert.ok((guide?.chunkCount ?? 0) > 1);
    assert.equal(guide?.chunkSizeChars, 300);
    assert.equal(guide?.chunkOverlapChars, 40);

    const disabled = await scanKnowledge(root, "rd-skills", "rev-config", {
      enabled: false,
      include: ["**/*.md"],
      exclude: [],
      maxDocumentBytes: 1024 * 1024,
      chunkSizeChars: 300,
      chunkOverlapChars: 40
    });
    assert.deepEqual(disabled, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge markdown frontmatter provides optional lifecycle metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-knowledge-lifecycle-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "recovery.md"),
      `---
owner: ota-team
status: active
tags: [ota, recovery]
created_at: 2026-01-01
updated_at: 2026-08-01
valid_from: 2026-01-01
valid_until: 2027-01-01
source: ota-runbook
supersedes: docs/ota/legacy-recovery.md
review_cycle: 90d
applicability:
  product: [ota-controller]
  branch: [release/*]
  firmware_version: ["3.*"]
  yocto_release: [kirkstone]
  kernel_version: ["5.15.*"]
  api_version: [v2]
  hardware_revision: [rev-c]
  variant: [internal]
---
# OTA Recovery Policy

Resume only from a validated safe checkpoint.
`,
      "utf8"
    );
    const documents = await scanKnowledge(root, "rd-skills", "rev-life");
    assert.equal(documents.length, 1);
    const document = documents[0]!;
    assert.equal(document.title, "OTA Recovery Policy");
    assert.deepEqual(document.metadata, {
      owner: "ota-team",
      status: "active",
      tags: ["ota", "recovery"],
      createdAt: "2026-01-01",
      updatedAt: "2026-08-01",
      validFrom: "2026-01-01",
      validUntil: "2027-01-01",
      source: "ota-runbook",
      supersedes: "docs/ota/legacy-recovery.md",
      reviewCycleDays: 90,
      applicability: {
        product: ["ota-controller"],
        branch: ["release/*"],
        firmwareVersion: ["3.*"],
        yoctoRelease: ["kirkstone"],
        kernelVersion: ["5.15.*"],
        apiVersion: ["v2"],
        hardwareRevision: ["rev-c"],
        variant: ["internal"]
      }
    });
    assert.doesNotMatch(document.content, /owner:\s*ota-team/);
    const chunks = chunksForDocuments(documents);
    assert.deepEqual(chunks[0]?.metadata, document.metadata);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge lifecycle audit reports maintenance risks", () => {
  const documents = [
    {
      key: "rd:a.md", repositoryId: "rd", revision: "r1", relativePath: "a.md", title: "Expired",
      content: "expired knowledge", chunkCount: 1, chunkSizeChars: 1400, chunkOverlapChars: 180,
      metadata: { owner: "ota-team", status: "active" as const, validUntil: "2025-01-01" }
    },
    {
      key: "rd:b.md", repositoryId: "rd", revision: "r1", relativePath: "b.md", title: "Deprecated",
      content: "deprecated knowledge", chunkCount: 1, chunkSizeChars: 1400, chunkOverlapChars: 180,
      metadata: { status: "deprecated" as const }
    },
    {
      key: "rd:c.md", repositoryId: "rd", revision: "r1", relativePath: "c.md", title: "Bad date",
      content: "bad date knowledge", chunkCount: 1, chunkSizeChars: 1400, chunkOverlapChars: 180,
      metadata: { owner: "platform", status: "active" as const, validUntil: "not-a-date" }
    },
    {
      key: "rd:d.md", repositoryId: "rd", revision: "r1", relativePath: "d.md", title: "Needs Review",
      content: "review cycle knowledge", chunkCount: 1, chunkSizeChars: 1400, chunkOverlapChars: 180,
      metadata: {
        owner: "ota-team",
        status: "active" as const,
        updatedAt: "2026-01-01",
        reviewCycleDays: 90
      }
    }
  ];
  const issues = auditKnowledgeLifecycle(documents, new Date("2026-09-29T00:00:00Z"));
  assert.ok(issues.some((item) => item.path === "a.md" && item.kind === "expired"));
  assert.ok(issues.some((item) => item.path === "b.md" && item.kind === "deprecated"));
  assert.ok(issues.some((item) => item.path === "b.md" && item.kind === "missing-owner"));
  assert.ok(issues.some((item) => item.path === "c.md" && item.kind === "invalid-valid-until"));
  assert.ok(issues.some((item) => item.path === "d.md" && item.kind === "review-overdue"));
});

test("knowledge search hides inactive lifecycle states and penalizes drafts", () => {
  const index = new KnowledgeIndex();
  try {
    const base = {
      repositoryId: "rd-skills",
      revision: "r1",
      chunkIndex: 0,
      content: "checkpoint recovery procedure"
    };
    index.rebuild([
      {
        ...base,
        key: "rd-skills:active.md#0",
        documentKey: "rd-skills:active.md",
        relativePath: "active.md",
        title: "Checkpoint Active",
        metadata: { owner: "ota", status: "active" as const }
      },
      {
        ...base,
        key: "rd-skills:draft.md#0",
        documentKey: "rd-skills:draft.md",
        relativePath: "draft.md",
        title: "Checkpoint Draft",
        metadata: { owner: "ota", status: "draft" as const }
      },
      ...(["deprecated", "superseded", "expired", "archived"] as const).map((status) => ({
        ...base,
        key: `rd-skills:${status}.md#0`,
        documentKey: `rd-skills:${status}.md`,
        relativePath: `${status}.md`,
        title: `Checkpoint ${status}`,
        metadata: { owner: "ota", status }
      })),
      {
        ...base,
        key: "rd-skills:future.md#0",
        documentKey: "rd-skills:future.md",
        relativePath: "future.md",
        title: "Checkpoint Future",
        metadata: { owner: "ota", status: "active" as const, validFrom: "2999-01-01" }
      },
      {
        ...base,
        key: "rd-skills:old.md#0",
        documentKey: "rd-skills:old.md",
        relativePath: "old.md",
        title: "Checkpoint Old",
        metadata: { owner: "ota", status: "active" as const, validUntil: "2000-01-01" }
      }
    ]);
    const results = index.search("checkpoint recovery", ["rd-skills"], 20);
    assert.deepEqual(
      results.map((item) => item.chunk.relativePath),
      ["active.md", "draft.md"]
    );
    assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 0));
    assert.match(results[1]?.reason ?? "", /draft penalty/);
  } finally {
    index.close();
  }
});

test("knowledge search filters declared version applicability only when context is supplied", () => {
  const index = new KnowledgeIndex();
  try {
    const base = {
      repositoryId: "rd-skills",
      revision: "r1",
      chunkIndex: 0,
      content: "ota checkpoint firmware procedure",
      title: "OTA checkpoint",
      metadata: { owner: "ota", status: "active" as const }
    };
    index.rebuild([
      {
        ...base,
        key: "rd-skills:v2.md#0",
        documentKey: "rd-skills:v2.md",
        relativePath: "v2.md",
        metadata: {
          ...base.metadata,
          applicability: { product: ["controller"], branch: ["release/*"], apiVersion: ["v2"] }
        }
      },
      {
        ...base,
        key: "rd-skills:v1.md#0",
        documentKey: "rd-skills:v1.md",
        relativePath: "v1.md",
        metadata: {
          ...base.metadata,
          applicability: { product: ["controller"], branch: ["legacy"], apiVersion: ["v1"] }
        }
      }
    ]);
    assert.equal(index.search("checkpoint firmware", ["rd-skills"], 10).length, 2);
    const filtered = index.search(
      "checkpoint firmware",
      ["rd-skills"],
      10,
      undefined,
      { product: "controller", branch: "release/3.2", apiVersion: "v2" }
    );
    assert.deepEqual(filtered.map((item) => item.chunk.relativePath), ["v2.md"]);
    assert.match(filtered[0]?.reason ?? "", /applicability matched/);
  } finally {
    index.close();
  }
});

test("knowledge ranking boosts exact phrases and tags with explainable reasons", () => {
  const index = new KnowledgeIndex();
  try {
    const base = {
      repositoryId: "rd-skills",
      revision: "r1",
      chunkIndex: 0
    };
    index.rebuild([
      {
        ...base,
        key: "rd-skills:tagged.md#0",
        documentKey: "rd-skills:tagged.md",
        relativePath: "docs/tagged.md",
        title: "Recovery Guide",
        content: "Generic firmware recovery notes.",
        metadata: { owner: "ota", status: "active" as const, tags: ["amber", "checkpoint"] }
      },
      {
        ...base,
        key: "rd-skills:phrase.md#0",
        documentKey: "rd-skills:phrase.md",
        relativePath: "docs/phrase.md",
        title: "Amber checkpoint resume",
        content: "Procedure for OTA recovery.",
        metadata: { owner: "ota", status: "active" as const }
      },
      {
        ...base,
        key: "rd-skills:generic.md#0",
        documentKey: "rd-skills:generic.md",
        relativePath: "docs/generic.md",
        title: "Checkpoint",
        content: "Amber data appears separately from resume state details.",
        metadata: { owner: "ota", status: "active" as const }
      }
    ]);
    const phraseResults = index.search("amber checkpoint resume", ["rd-skills"], 10);
    assert.equal(phraseResults[0]?.chunk.relativePath, "docs/phrase.md");
    assert.match(phraseResults[0]?.reason ?? "", /exact-title-phrase\+8\.00/);

    const tagResults = index.search("amber checkpoint", ["rd-skills"], 10);
    const tagged = tagResults.find((item) => item.chunk.relativePath === "docs/tagged.md");
    assert.ok(tagged);
    assert.match(tagged?.reason ?? "", /tags\+/);
    assert.match(tagged?.reason ?? "", /score=/);
  } finally {
    index.close();
  }
});

test("markdown chunking keeps heading sections separate and retrieves long-document sections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-heading-chunks-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "long-guide.md"),
      [
        "# OTA Guide",
        "",
        "General introduction " + "overview ".repeat(30),
        "",
        "## Recovery State Machine",
        "",
        "amber-sentinel recovery checkpoint resumes only after image integrity validation. " + "recovery ".repeat(35),
        "",
        "## CVE Operations",
        "",
        "cobalt-remediation six month CVE workflow assigns ownership before release. " + "security ".repeat(35)
      ].join("\n"),
      "utf8"
    );
    const documents = await scanKnowledge(root, "rd-skills", "rev-heading", {
      enabled: true,
      include: ["docs/**"],
      exclude: [],
      maxDocumentBytes: 1024 * 1024,
      chunkSizeChars: 260,
      chunkOverlapChars: 30
    });
    const chunks = chunksForDocuments(documents);
    assert.ok(chunks.length >= 3);
    assert.ok(chunks.some((item) => item.content.startsWith("## Recovery State Machine")));
    assert.ok(chunks.some((item) => item.content.startsWith("## CVE Operations")));
    assert.ok(
      chunks.every(
        (item) => !(item.content.includes("amber-sentinel") && item.content.includes("cobalt-remediation"))
      ),
      "separate heading sections should not be merged into one chunk"
    );
    const index = new KnowledgeIndex();
    try {
      index.rebuild(chunks);
      const recovery = index.search("amber-sentinel image integrity", ["rd-skills"], 3);
      assert.equal(recovery[0]?.chunk.relativePath, "docs/long-guide.md");
      assert.match(recovery[0]?.chunk.content ?? "", /Recovery State Machine/);
      const cve = index.search("cobalt-remediation ownership release", ["rd-skills"], 3);
      assert.match(cve[0]?.chunk.content ?? "", /CVE Operations/);
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("markdown chunking preserves fenced code and table blocks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-structured-chunks-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    const fence = String.fromCharCode(96).repeat(3);
    await writeFile(
      path.join(root, "docs", "structured.md"),
      [
        "# Diagnostics",
        "",
        "## Command",
        "",
        "Run the recovery probe:",
        "",
        fence + "bash",
        "echo start",
        "",
        "ota_probe --checkpoint amber",
        fence,
        "",
        "## Matrix",
        "",
        "| Variant | Result |",
        "| --- | --- |",
        "| rev-a | pass |",
        "| rev-b | retry |"
      ].join("\n"),
      "utf8"
    );
    const documents = await scanKnowledge(root, "rd-skills", "rev-structured", {
      enabled: true,
      include: ["docs/**"],
      exclude: [],
      maxDocumentBytes: 1024 * 1024,
      chunkSizeChars: 300,
      chunkOverlapChars: 30
    });
    const chunks = chunksForDocuments(documents);
    const codeChunk = chunks.find((item) => item.content.includes("ota_probe --checkpoint amber"));
    assert.ok(codeChunk);
    assert.match(codeChunk?.content ?? "", /echo start\n\nota_probe/);
    assert.ok((codeChunk?.content.match(/```/g)?.length ?? 0) >= 2);
    const tableChunk = chunks.find((item) => item.content.includes("| rev-b | retry |"));
    assert.ok(tableChunk);
    assert.match(tableChunk?.content ?? "", /\| Variant \| Result \|[\s\S]*\| rev-a \| pass \|[\s\S]*\| rev-b \| retry \|/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge scanner extracts text from DOCX and PDF", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-knowledge-binary-"));
  try {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    );
    zip.folder("_rels")?.file(
      ".rels",
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    );
    zip.folder("word")?.file(
      "document.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX recovery checkpoint marker</w:t></w:r></w:p></w:body></w:document>'
    );
    await writeFile(path.join(root, "guide.docx"), await zip.generateAsync({ type: "nodebuffer" }));

    const content = "BT /F1 18 Tf 72 720 Td (PDF recovery checkpoint marker) Tj ET";
    const objects = [
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
      "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
      `5 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream\nendobj\n`
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const object of objects) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += object;
    }
    const xrefOffset = Buffer.byteLength(pdf);
    pdf += "xref\n0 6\n0000000000 65535 f \n";
    for (let index = 1; index <= 5; index += 1) {
      pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    await writeFile(path.join(root, "guide.pdf"), pdf, "binary");

    const documents = await scanKnowledge(root, "rd-skills", "rev-binary");
    const docx = documents.find((document) => document.relativePath === "guide.docx");
    const pdfDocument = documents.find((document) => document.relativePath === "guide.pdf");
    assert.match(docx?.content ?? "", /DOCX recovery checkpoint marker/);
    assert.match(pdfDocument?.content ?? "", /PDF recovery checkpoint marker/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge FTS candidate query filters repositories before applying its limit", () => {
  const index = new KnowledgeIndex();
  try {
    const denied = Array.from({ length: 80 }, (_, i) => ({
      key: `private:docs/private-${i}.md#0`,
      documentKey: `private:docs/private-${i}.md`,
      repositoryId: "private",
      revision: "rev-private",
      relativePath: `docs/private-${i}.md`,
      title: "checkpoint checkpoint checkpoint checkpoint",
      chunkIndex: 0,
      content: "checkpoint"
    }));
    const allowed = {
      key: "rd-skills:docs/allowed.md#0",
      documentKey: "rd-skills:docs/allowed.md",
      repositoryId: "rd-skills",
      revision: "rev-allowed",
      relativePath: "docs/allowed.md",
      title: "Allowed",
      chunkIndex: 0,
      content: "checkpoint"
    };
    index.rebuild([...denied, allowed]);
    const results = index.search("checkpoint", ["rd-skills"], 1);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.chunk.key, allowed.key);
    assert.ok((results[0]?.score ?? 0) > 1.5, "allowed result should receive an FTS score");
  } finally {
    index.close();
  }
});

test("knowledge FTS search supports Chinese context and repository filtering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-knowledge-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "recovery.md"),
      "# OTA Recovery\n\n升级过程中突然断电后，恢复状态机会读取安全检查点并继续升级。\n",
      "utf8"
    );
    const documents = await scanKnowledge(root, "rd-skills", "rev-2");
    const index = new KnowledgeIndex();
    try {
      index.rebuild(chunksForDocuments(documents));
      const results = index.search("断电恢复怎么处理", ["rd-skills"], 5);
      assert.ok(results.length > 0);
      assert.equal(results[0]?.chunk.relativePath, "docs/recovery.md");
      assert.match(results[0]?.chunk.content ?? "", /断电/);

      const denied = index.search("断电恢复", ["customer-skills"], 5);
      assert.equal(denied.length, 0);
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
