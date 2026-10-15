// Stage 2 — Clean: unicode normalisation, repeated header/footer removal,
// page-number removal, and detection of the body font/size used later to tell
// headings from body text.

import type { CleanDoc, PdfLine, UploadedFile } from "../types";
import { cleanUnicode } from "../lib/text";

const PAGE_NUMBER = /^(?:page|p\.|صفحة|ص)?\s*\d{1,4}(?:\s*(?:of|\/|من)\s*\d{1,4})?$/i;

function weightedMedian(values: { v: number; w: number }[]): number {
  if (!values.length) return 10;
  const sorted = [...values].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (const x of sorted) {
    acc += x.w;
    if (acc >= total / 2) return x.v;
  }
  return sorted[sorted.length - 1].v;
}

export interface CleanReport {
  docs: {
    docId: string;
    name: string;
    pages: number;
    linesIn: number;
    linesOut: number;
    unicodeFixed: number;
    removedRepeated: string[];
    removedPageNumbers: number;
    bodyFontSize: number;
    chars: number;
  }[];
  samples: { before: string; after: string }[];
}

export function cleanDocuments(files: UploadedFile[]): { docs: CleanDoc[]; report: CleanReport } {
  const report: CleanReport = { docs: [], samples: [] };
  const docs: CleanDoc[] = files.map((file, idx) => {
    const docId = `D${idx + 1}`;
    let linesIn = 0;
    let unicodeFixed = 0;
    let removedPageNumbers = 0;

    // 1) unicode + whitespace normalisation, drop empty lines
    const pages = file.pages.map((p) => {
      const lines: PdfLine[] = [];
      for (const l of p.lines) {
        linesIn++;
        const text = cleanUnicode(l.text).replace(/\s+/g, " ").trim();
        if (text !== l.text.trim()) {
          unicodeFixed++;
          if (report.samples.length < 3 && /[ﭐ-﷿ﹰ-﻿​-‏]/.test(l.text)) {
            report.samples.push({ before: l.text.slice(0, 120), after: text.slice(0, 120) });
          }
        }
        if (!text) continue;
        const cells = l.cells?.map((c) => cleanUnicode(c).replace(/\s+/g, " ").trim()).filter(Boolean) ?? null;
        lines.push({ ...l, text, cells: cells && cells.length >= 2 ? cells : null });
      }
      return { ...p, lines };
    });

    // 2) page numbers near the top/bottom edge
    for (const p of pages) {
      p.lines = p.lines.filter((l) => {
        const nearEdge = l.y > p.height * 0.9 || l.y < p.height * 0.1;
        if (nearEdge && PAGE_NUMBER.test(l.text)) {
          removedPageNumbers++;
          return false;
        }
        return true;
      });
    }

    // 3) running headers/footers: same text near an edge on >= 60% of pages (3+ pages)
    const removedRepeated: string[] = [];
    if (pages.length >= 3) {
      const counts = new Map<string, number>();
      for (const p of pages) {
        const seen = new Set<string>();
        for (const l of p.lines) {
          if (l.y > p.height * 0.9 || l.y < p.height * 0.08) {
            const key = l.text.replace(/\d+/g, "#").toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              counts.set(key, (counts.get(key) || 0) + 1);
            }
          }
        }
      }
      const repeated = new Set([...counts].filter(([, c]) => c >= Math.ceil(pages.length * 0.6)).map(([k]) => k));
      if (repeated.size) {
        for (const p of pages) {
          p.lines = p.lines.filter((l) => {
            const key = l.text.replace(/\d+/g, "#").toLowerCase();
            const edge = l.y > p.height * 0.9 || l.y < p.height * 0.08;
            if (edge && repeated.has(key)) {
              if (!removedRepeated.includes(l.text)) removedRepeated.push(l.text);
              return false;
            }
            return true;
          });
        }
      }
    }

    // 4) body font: weighted median height of non-table lines, then the dominant font at that size
    const all = pages.flatMap((p) => p.lines);
    const bodyHeight = weightedMedian(all.filter((l) => !l.cells).map((l) => ({ v: Math.round(l.h * 10) / 10, w: l.text.length })));
    const fontChars = new Map<string, number>();
    for (const l of all) {
      if (Math.abs(l.h - bodyHeight) <= bodyHeight * 0.1) fontChars.set(l.font, (fontChars.get(l.font) || 0) + l.text.length);
    }
    const bodyFont = [...fontChars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    const linesOut = all.length;

    report.docs.push({
      docId,
      name: file.name,
      pages: pages.length,
      linesIn,
      linesOut,
      unicodeFixed,
      removedRepeated,
      removedPageNumbers,
      bodyFontSize: bodyHeight,
      chars: all.reduce((s, l) => s + l.text.length, 0),
    });
    return { docId, name: file.name, pageCount: file.pageCount || pages.length, bodyHeight, bodyFont, pages };
  });
  return { docs, report };
}
