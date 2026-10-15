// Stage 1 — "Read the files" runs in the browser with PDF.js: text lines,
// table cells and a page-1 render for the document tiles. Only the extracted
// text goes to the server.

import { linesFromTextContent } from "./pdf-lines.js";

let pdfjs = null;
async function lib() {
  if (!pdfjs) {
    pdfjs = await import("/vendor/pdfjs/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
  }
  return pdfjs;
}

async function renderThumb(page, width = 360) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return canvas.toDataURL("image/jpeg", 0.82);
}

/**
 * @param {File[]} files
 * @param {(p:{file:string, page:number, pages:number}) => void} onProgress
 */
export async function parsePdfFiles(files, onProgress = () => {}) {
  const { getDocument } = await lib();
  const started = performance.now();
  const parsed = [];
  for (const file of files) {
    const data = new Uint8Array(await file.arrayBuffer());
    const task = getDocument({
      data,
      isEvalSupported: false,
      standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
      wasmUrl: "/vendor/pdfjs/wasm/",
      verbosity: 0,
    });
    const pdf = await task.promise;
    const pages = [];
    let thumb = null;
    for (let n = 1; n <= pdf.numPages; n++) {
      onProgress({ file: file.name, page: n, pages: pdf.numPages });
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      pages.push({ page: n, width: vp.width, height: vp.height, lines: linesFromTextContent(tc) });
      if (n === 1) {
        try {
          thumb = await renderThumb(page);
        } catch (e) {
          console.warn("Page preview failed", file.name, e);
          thumb = null;
        }
      }
      page.cleanup();
    }
    await task.destroy(); // PDF.js 6: documents are released through their loading task
    const lines = pages.flatMap((p) => p.lines);
    parsed.push({
      name: file.name,
      size: file.size,
      pageCount: pages.length,
      pages,
      thumb,
      stats: {
        lines: lines.length,
        chars: lines.reduce((n, l) => n + l.text.length, 0),
        tableRows: lines.filter((l) => l.cells).length,
      },
    });
  }
  return { parsed, ms: performance.now() - started };
}
