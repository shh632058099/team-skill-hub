import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { chunksForDocuments, KnowledgeIndex, scanKnowledge } from "../src/knowledge.js";

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
