import { spawnSync } from "node:child_process";
import * as XLSX from "xlsx";

const [from, to] = process.argv.slice(2);
if (!from || !to) throw new Error("Usage: node scripts/send-test-xlsx.mjs <from> <to>");

const generatedAt = new Date();
const subject = `cfmail Spreadsheets attachment test ${generatedAt.toISOString()}`;
const workbook = XLSX.utils.book_new();
const worksheet = XLSX.utils.aoa_to_sheet([
  ["cfmail Spreadsheets attachment test", null, null],
  ["Item", "Amount", "With VAT"],
  ["Services", 1250, { f: "B3*1.2", v: 1500 }],
  ["Software", 300, { f: "B4*1.2", v: 360 }],
  ["Total", { f: "SUM(B3:B4)", v: 1550 }, { f: "SUM(C3:C4)", v: 1860 }],
]);
worksheet.B3.z = worksheet.C3.z = worksheet.B4.z = worksheet.C4.z = worksheet.B5.z = worksheet.C5.z = "£#,##0.00";
worksheet["!cols"] = [{ wch: 28 }, { wch: 14 }, { wch: 14 }];
XLSX.utils.book_append_sheet(workbook, worksheet, "Invoice test");
const bytes = Buffer.from(XLSX.write(workbook, { bookType: "xlsx", type: "array", compression: true }));
const encoded = bytes.toString("base64").match(/.{1,76}/g)?.join("\r\n") || "";
const boundary = `cfmail-spreadsheet-test-${generatedAt.valueOf()}`;
const mime = [
  `From: cfmail Test <${from}>`,
  `To: ${to}`,
  `Subject: ${subject}`,
  `Date: ${generatedAt.toUTCString()}`,
  `Message-ID: <spreadsheet-attachment-test-${generatedAt.valueOf()}@cfmail.invalid>`,
  "MIME-Version: 1.0",
  `Content-Type: multipart/mixed; boundary="${boundary}"`,
  "",
  `--${boundary}`,
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: 7bit",
  "",
  "Synthetic integration test for opening a spreadsheet attachment from cfmail.",
  "",
  `--${boundary}`,
  "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "Content-Transfer-Encoding: base64",
  "Content-Disposition: attachment; filename=\"cfmail-spreadsheet-attachment-test.xlsx\"",
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
