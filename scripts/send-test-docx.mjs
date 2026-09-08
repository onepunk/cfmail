import { spawnSync } from "node:child_process";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";

const [from, to] = process.argv.slice(2);
if (!from || !to) throw new Error("Usage: node scripts/send-test-docx.mjs <from> <to>");

const generatedAt = new Date();
const subject = `cfmail Documents attachment test ${generatedAt.toISOString()}`;
const document = new Document({
  sections: [{
    children: [
      new Paragraph({ text: "cfmail Documents attachment test", heading: HeadingLevel.TITLE }),
      new Paragraph({ children: [new TextRun({ text: "Purpose: ", bold: true }), new TextRun("Verify that a .docx attached to a mail opens directly in cfmail Documents.")] }),
      new Paragraph({ text: "This line should remain normal body text." }),
      new Table({ rows: [
        new TableRow({ children: [new TableCell({ children: [new Paragraph({ text: "Feature" })] }), new TableCell({ children: [new Paragraph({ text: "Expected result" })] })] }),
        new TableRow({ children: [new TableCell({ children: [new Paragraph({ text: "Mail attachment" })] }), new TableCell({ children: [new Paragraph({ text: "Opens in cfmail Documents" })] })] }),
      ] }),
    ],
  }],
});
const bytes = await Packer.toBuffer(document);
const encoded = bytes.toString("base64").match(/.{1,76}/g)?.join("\r\n") || "";
const boundary = `cfmail-document-test-${generatedAt.valueOf()}`;
const mime = [
  `From: cfmail Test <${from}>`,
  `To: ${to}`,
  `Subject: ${subject}`,
  `Date: ${generatedAt.toUTCString()}`,
  `Message-ID: <document-attachment-test-${generatedAt.valueOf()}@cfmail.invalid>`,
  "MIME-Version: 1.0",
  `Content-Type: multipart/mixed; boundary=\"${boundary}\"`,
  "",
  `--${boundary}`,
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: 7bit",
  "",
  "Synthetic integration test for opening a document attachment from cfmail.",
  "",
  `--${boundary}`,
  "Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "Content-Transfer-Encoding: base64",
  "Content-Disposition: attachment; filename=\"cfmail-document-attachment-test.docx\"",
  "",
  encoded,
  `--${boundary}--`,
  "",
].join("\r\n");

const result = spawnSync("npx", [
  "wrangler", "email", "sending", "send-raw",
  "--from", from,
  "--to", to,
  "--mime", mime,
], {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status || 1);
console.log(`TEST_SUBJECT=${subject}`);
