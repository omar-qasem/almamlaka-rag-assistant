// Stage 3 — Structure: title / subtitle / numbered headings / paragraphs / tables.
// Uses font size relative to the body text, the body font id, and numbering
// patterns (1., 2.1, أولاً ...). Tables come from lines that PDF.js laid out as
// separated cells.

import type { Block, CleanDoc, PdfLine, Section, StructuredDoc } from "../types";
import { detectLanguage } from "../lib/text";

const NUMBERED = /^(\d{1,2}(?:\.\d{1,2})*)[.)]?\s+(\S.*)$/;
const AR_NUMBERED = /^([٠-٩۰-۹]{1,2})[.)\-–]\s*(\S.*)$/;
const AR_ORDINALS = ["أولا", "ثانيا", "ثالثا", "رابعا", "خامسا", "سادسا", "سابعا", "ثامنا", "تاسعا", "عاشرا"];
const SENTENCE_END = /[.!?؟:;؛]$/;

function parseHeading(text: string): { number: string | null; title: string } {
  const m = text.match(NUMBERED) || text.match(AR_NUMBERED);
  if (m) return { number: m[1], title: m[2].trim() };
  const plain = text.replace(/[ًٌٍَُِّْ]/g, "");
  const idx = AR_ORDINALS.findIndex((o) => plain.startsWith(o));
  if (idx >= 0) return { number: String(idx + 1), title: text.replace(/^\S+[:\s\-–]*/, "").trim() };
  return { number: null, title: text.trim() };
}

const isNumbered = (t: string) => NUMBERED.test(t) || AR_NUMBERED.test(t) || AR_ORDINALS.some((o) => t.replace(/[ًٌٍَُِّْ]/g, "").startsWith(o));

export interface StructureReport {
  docs: {
    docId: string;
    name: string;
    title: string;
    subtitle: string;
    language: string;
    sections: { key: string; number: string | null; title: string; pageStart: number; pageEnd: number; paragraphs: number; tables: number; tableRows: number }[];
  }[];
}

export function detectStructure(docs: CleanDoc[]): { structured: StructuredDoc[]; report: StructureReport } {
  const report: StructureReport = { docs: [] };
  const structured = docs.map((doc) => {
    const bodyH = doc.bodyHeight || 10;
    const ordered: { line: PdfLine; page: number }[] = [];
    for (const p of [...doc.pages].sort((a, b) => a.page - b.page)) {
      for (const line of [...p.lines].sort((a, b) => b.y - a.y || a.x - b.x)) ordered.push({ line, page: p.page });
    }

    // Typical vertical distance between consecutive body lines (paragraph detection).
    const gaps: number[] = [];
    for (let i = 1; i < ordered.length; i++) {
      const a = ordered[i - 1], b = ordered[i];
      if (a.page === b.page && !a.line.cells && !b.line.cells && Math.abs(a.line.h - bodyH) < bodyH * 0.15 && Math.abs(b.line.h - bodyH) < bodyH * 0.15) {
        const g = a.line.y - b.line.y;
        if (g > 0 && g < bodyH * 3) gaps.push(g);
      }
    }
    gaps.sort((x, y) => x - y);
    const lineSpacing = gaps.length ? gaps[Math.floor(gaps.length / 2)] : bodyH * 1.4;

    // Title & subtitle: large lines at the top of page 1, before the first heading.
    let title = "";
    let subtitle = "";
    const used = new Set<number>();
    const firstPage = ordered.filter((o) => o.page === ordered[0]?.page);
    const maxH = Math.max(0, ...firstPage.map((o) => o.line.h));
    if (maxH >= bodyH * 1.5) {
      for (let i = 0; i < ordered.length && ordered[i].page === ordered[0].page; i++) {
        const { line } = ordered[i];
        if (isNumbered(line.text)) break;
        if (!title && line.h >= maxH * 0.95) {
          title = line.text;
          used.add(i);
          // a wrapped title continues on the next line with the same size
          while (i + 1 < ordered.length && ordered[i + 1].line.h >= maxH * 0.95 && !isNumbered(ordered[i + 1].line.text)) {
            title += " " + ordered[++i].line.text;
            used.add(i);
          }
          continue;
        }
        if (title && !subtitle && line.h > bodyH * 1.1 && !line.cells) {
          subtitle = line.text;
          used.add(i);
          continue;
        }
        if (title) break;
      }
    }

    const isHeading = (l: PdfLine) =>
      !l.cells &&
      l.text.length <= 120 &&
      ((l.h >= bodyH * 1.25 && (isNumbered(l.text) || l.h >= bodyH * 1.4 || !SENTENCE_END.test(l.text))) ||
        (l.font !== doc.bodyFont && isNumbered(l.text) && l.h >= bodyH * 0.95));

    const sections: Section[] = [];
    let current: Section | null = null;
    let paragraph: { text: string; page: number; lastY: number; lastPage: number } | null = null;
    let table: Extract<Block, { type: "table" }> | null = null;

    const ensureSection = (page: number) => {
      if (!current) {
        current = { key: "S0", number: null, title: "Preamble", heading: "", pageStart: page, pageEnd: page, blocks: [] };
        sections.push(current);
      }
      return current;
    };
    const flushParagraph = () => {
      if (paragraph && current) current.blocks.push({ type: "paragraph", text: paragraph.text.trim(), page: paragraph.page });
      paragraph = null;
    };
    const flushTable = () => {
      if (table && current) current.blocks.push(table);
      table = null;
    };

    ordered.forEach(({ line, page }, i) => {
      if (used.has(i)) return;
      if (isHeading(line)) {
        flushParagraph();
        flushTable();
        const { number, title: hTitle } = parseHeading(line.text);
        current = { key: `S${sections.filter((s) => s.key !== "S0").length + 1}`, number, title: hTitle, heading: line.text, pageStart: page, pageEnd: page, blocks: [] };
        sections.push(current);
        return;
      }
      const sec = ensureSection(page);
      sec.pageEnd = Math.max(sec.pageEnd, page);

      if (line.cells) {
        flushParagraph();
        if (!table) table = { type: "table", header: line.cells, rows: [], page, pageEnd: page };
        else {
          table.rows.push(line.cells);
          table.pageEnd = page;
        }
        return;
      }
      flushTable();

      const startsNew =
        !paragraph ||
        (paragraph.lastPage === page && paragraph.lastY - line.y > lineSpacing * 1.45) ||
        (paragraph.lastPage !== page && SENTENCE_END.test(paragraph.text.trim()));
      if (startsNew) {
        flushParagraph();
        paragraph = { text: line.text, page, lastY: line.y, lastPage: page };
      } else if (paragraph) {
        const prev = paragraph.text;
        paragraph.text = /[A-Za-z]-$/.test(prev) && /^[a-z]/.test(line.text) ? prev.slice(0, -1) + line.text : `${prev} ${line.text}`;
        paragraph.lastY = line.y;
        paragraph.lastPage = page;
      }
    });
    flushParagraph();
    flushTable();

    const nonEmpty = sections.filter((s) => s.blocks.length || s.key !== "S0");
    const allText = nonEmpty.flatMap((s) => [s.title, ...s.blocks.map((b) => (b.type === "paragraph" ? b.text : [...b.header, ...b.rows.flat()].join(" ")))]).join(" ");
    const sd: StructuredDoc = {
      docId: doc.docId,
      name: doc.name,
      title: title || doc.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " "),
      subtitle,
      pageCount: doc.pageCount,
      language: detectLanguage(allText).lang,
      sections: nonEmpty,
    };
    report.docs.push({
      docId: sd.docId,
      name: sd.name,
      title: sd.title,
      subtitle: sd.subtitle,
      language: sd.language,
      sections: sd.sections.map((s) => ({
        key: s.key,
        number: s.number,
        title: s.title,
        pageStart: s.pageStart,
        pageEnd: s.pageEnd,
        paragraphs: s.blocks.filter((b) => b.type === "paragraph").length,
        tables: s.blocks.filter((b) => b.type === "table").length,
        tableRows: s.blocks.reduce((n, b) => n + (b.type === "table" ? b.rows.length : 0), 0),
      })),
    });
    return sd;
  });
  return { structured, report };
}
