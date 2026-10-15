// Stage 4 — Chunk: structure-aware chunking.
//   * one numbered section = one chunk (the natural unit of meaning in these
//     reports, and it keeps page citations exact);
//   * sections longer than maxTokens are split on block boundaries, then on
//     sentences, with a small sentence overlap; tables split by rows with the
//     header repeated;
//   * near-empty sections are merged into the next one.

import { config } from "../config";
import type { Block, Chunk, StructuredDoc } from "../types";
import { estimateTokens, splitSentences } from "../lib/text";

export function renderBlock(b: Block): string {
  if (b.type === "paragraph") return b.text;
  const width = Math.max(b.header.length, ...b.rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(Math.max(0, width - r.length)).fill("")];
  const row = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  return [row(b.header), `| ${Array(width).fill("---").join(" | ")} |`, ...b.rows.map(row)].join("\n");
}

interface Piece {
  text: string;
  page: number;
  pageEnd: number;
  kind: "paragraph" | "table";
}

function splitOversized(b: Block, max: number): Piece[] {
  if (b.type === "table") {
    const header = { ...b, rows: [] as string[][] };
    const pieces: Piece[] = [];
    let rows: string[][] = [];
    for (const r of b.rows) {
      const candidate = renderBlock({ ...header, rows: [...rows, r] });
      if (rows.length && estimateTokens(candidate) > max) {
        pieces.push({ text: renderBlock({ ...header, rows }), page: b.page, pageEnd: b.pageEnd, kind: "table" });
        rows = [];
      }
      rows.push(r);
    }
    if (rows.length || !pieces.length) pieces.push({ text: renderBlock({ ...header, rows }), page: b.page, pageEnd: b.pageEnd, kind: "table" });
    return pieces;
  }
  const text = b.text;
  if (estimateTokens(text) <= max) return [{ text, page: b.page, pageEnd: b.page, kind: "paragraph" }];
  const pieces: Piece[] = [];
  let buf = "";
  for (const s of splitSentences(text)) {
    if (buf && estimateTokens(`${buf} ${s}`) > max) {
      pieces.push({ text: buf, page: b.page, pageEnd: b.page, kind: "paragraph" });
      buf = "";
    }
    buf = buf ? `${buf} ${s}` : s;
  }
  if (buf) pieces.push({ text: buf, page: b.page, pageEnd: b.page, kind: "paragraph" });
  return pieces;
}

function overlapTail(text: string, budget: number): string {
  const sentences = splitSentences(text);
  const out: string[] = [];
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (estimateTokens([sentences[i], ...out].join(" ")) > budget) break;
    out.unshift(sentences[i]);
  }
  return out.join(" ");
}

export interface ChunkReport {
  strategy: { method: string; maxTokens: number; overlapTokens: number; minTokens: number };
  stats: { count: number; min: number; max: number; avg: number; perDoc: Record<string, number>; split: number; merged: number };
  histogram: { from: number; to: number; count: number }[];
  chunks: { id: string; docId: string; section: string; pageStart: number; pageEnd: number; tokens: number; type: string; preview: string }[];
}

export function chunkDocuments(docs: StructuredDoc[]): { chunks: Chunk[]; report: ChunkReport } {
  const { maxTokens, overlapTokens, minTokens } = config.chunking;
  const chunks: Chunk[] = [];
  let split = 0;
  let merged = 0;

  for (const doc of docs) {
    let carry: { heading: string; pieces: Piece[] } | null = null;
    doc.sections.forEach((sec, si) => {
      const heading = sec.heading || sec.title;
      let pieces: Piece[] = sec.blocks.flatMap((b) => splitOversized(b, maxTokens - estimateTokens(heading) - 4));
      let fullHeading = heading;
      if (carry) {
        pieces = [...carry.pieces, ...pieces];
        fullHeading = carry.heading ? `${carry.heading}\n${heading}` : heading;
        carry = null;
        merged++;
      }
      const bodyTokens = pieces.reduce((n, p) => n + estimateTokens(p.text), 0);
      if (bodyTokens < minTokens && si < doc.sections.length - 1) {
        carry = { heading: fullHeading, pieces };
        return;
      }

      // Pack pieces into chunks under the token budget.
      const groups: Piece[][] = [];
      let group: Piece[] = [];
      let groupTokens = estimateTokens(fullHeading);
      for (const p of pieces) {
        const t = estimateTokens(p.text);
        if (group.length && groupTokens + t > maxTokens) {
          groups.push(group);
          const prev = group[group.length - 1];
          const tail = prev.kind === "paragraph" ? overlapTail(prev.text, overlapTokens) : "";
          group = tail ? [{ ...prev, text: tail }] : [];
          groupTokens = estimateTokens(fullHeading) + (tail ? estimateTokens(tail) : 0);
        }
        group.push(p);
        groupTokens += t;
      }
      if (group.length || !groups.length) groups.push(group);
      if (groups.length > 1) split++;

      groups.forEach((g, gi) => {
        const head = groups.length > 1 && gi > 0 ? `${fullHeading} (continued)` : fullHeading;
        const body = g.map((p) => p.text).join("\n");
        const text = body ? `${head}\n${body}` : head;
        const kinds = new Set(g.map((p) => p.kind));
        const pages = g.length ? g.flatMap((p) => [p.page, p.pageEnd]) : [sec.pageStart];
        chunks.push({
          id: groups.length > 1 ? `${doc.docId}-${sec.key}-${gi + 1}` : `${doc.docId}-${sec.key}`,
          docId: doc.docId,
          docName: doc.name,
          docTitle: doc.title,
          docSubtitle: doc.subtitle,
          sectionKey: sec.key,
          sectionNumber: sec.number,
          sectionTitle: sec.title,
          pageStart: Math.min(...pages),
          pageEnd: Math.max(...pages),
          type: kinds.size === 2 ? "mixed" : kinds.has("table") ? "table" : "text",
          tokens: estimateTokens(text),
          text,
          context: `${doc.title}${doc.subtitle ? ` — ${doc.subtitle}` : ""}, section ${sec.number ? `${sec.number}. ` : ""}${sec.title}.`,
          keywordsEn: [],
          keywordsAr: [],
        });
      });
    });
    if (carry) {
      const c = carry as { heading: string; pieces: Piece[] };
      const text = [c.heading, ...c.pieces.map((p) => p.text)].join("\n");
      const last = doc.sections[doc.sections.length - 1];
      chunks.push({
        id: `${doc.docId}-${last.key}`,
        docId: doc.docId,
        docName: doc.name,
        docTitle: doc.title,
        docSubtitle: doc.subtitle,
        sectionKey: last.key,
        sectionNumber: last.number,
        sectionTitle: last.title,
        pageStart: last.pageStart,
        pageEnd: last.pageEnd,
        type: "text",
        tokens: estimateTokens(text),
        text,
        context: `${doc.title}, section ${last.title}.`,
        keywordsEn: [],
        keywordsAr: [],
      });
    }
  }

  const sizes = chunks.map((c) => c.tokens);
  const perDoc: Record<string, number> = {};
  for (const c of chunks) perDoc[c.docId] = (perDoc[c.docId] || 0) + 1;
  const binSize = 25;
  const top = Math.max(binSize, Math.ceil(Math.max(0, ...sizes) / binSize) * binSize);
  const histogram = [];
  for (let from = 0; from < top; from += binSize) {
    histogram.push({ from, to: from + binSize, count: sizes.filter((s) => s >= from && s < from + binSize).length });
  }

  return {
    chunks,
    report: {
      strategy: { method: "structure-aware: one numbered section per chunk", maxTokens, overlapTokens, minTokens },
      stats: {
        count: chunks.length,
        min: sizes.length ? Math.min(...sizes) : 0,
        max: sizes.length ? Math.max(...sizes) : 0,
        avg: sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0,
        perDoc,
        split,
        merged,
      },
      histogram,
      chunks: chunks.map((c) => ({
        id: c.id,
        docId: c.docId,
        section: `${c.sectionNumber ? `${c.sectionNumber}. ` : ""}${c.sectionTitle}`,
        pageStart: c.pageStart,
        pageEnd: c.pageEnd,
        tokens: c.tokens,
        type: c.type,
        preview: c.text,
      })),
    },
  };
}
