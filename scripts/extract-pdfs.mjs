// Extracts PDFs into the same upload payload the browser sends to /api/ingest.
// Usage: node scripts/extract-pdfs.mjs file1.pdf file2.pdf ... > payload.json
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { linesFromTextContent } from "../public/assets/js/pdf-lines.js";

export async function extractPdf(path) {
  const data = new Uint8Array(readFileSync(path));
  const pdf = await getDocument({ data, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({ page: n, width: vp.width, height: vp.height, lines: linesFromTextContent(tc) });
  }
  return { name: basename(path), size: data.byteLength, pageCount: pdf.numPages, pages };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = [];
  for (const p of process.argv.slice(2)) files.push(await extractPdf(p));
  process.stdout.write(JSON.stringify({ files }, null, 1));
}
