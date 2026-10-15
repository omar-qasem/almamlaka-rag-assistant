// Stage 5 — Contextual enrichment (Anthropic's "contextual retrieval" idea):
// for every chunk, a small LLM writes one sentence that situates the chunk in
// its document and bilingual keywords. The text is prepended to the chunk only
// for embedding / BM25 / reranking, never shown as source text.
// It also produces Arabic + English labels and suggested questions per document.
// If Groq is unavailable the pipeline continues with deterministic headers.

import { config } from "../config";
import { groqStructured } from "../lib/groq";
import { renderBlock } from "./chunk";
import { truncate } from "../lib/text";
import type { Chunk, DocProfile, StructuredDoc } from "../types";

const SCHEMA = {
  type: "object",
  properties: {
    doc_label_en: { type: "string" },
    doc_label_ar: { type: "string" },
    doc_summary_en: { type: "string" },
    doc_summary_ar: { type: "string" },
    suggested_questions_en: { type: "array", items: { type: "string" } },
    suggested_questions_ar: { type: "array", items: { type: "string" } },
    chunks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          chunk_id: { type: "string" },
          context: { type: "string" },
          keywords_en: { type: "array", items: { type: "string" } },
          keywords_ar: { type: "array", items: { type: "string" } },
        },
        required: ["chunk_id", "context", "keywords_en", "keywords_ar"],
        additionalProperties: false,
      },
    },
  },
  required: ["doc_label_en", "doc_label_ar", "doc_summary_en", "doc_summary_ar", "suggested_questions_en", "suggested_questions_ar", "chunks"],
  additionalProperties: false,
} as const;

interface EnrichOut {
  doc_label_en: string;
  doc_label_ar: string;
  doc_summary_en: string;
  doc_summary_ar: string;
  suggested_questions_en: string[];
  suggested_questions_ar: string[];
  chunks: { chunk_id: string; context: string; keywords_en: string[]; keywords_ar: string[] }[];
}

const SYSTEM = `You prepare document chunks for a bilingual (Arabic/English) search index.
For the document in the user message, return:
- doc_label_en / doc_label_ar: a short label (2-4 words) naming what the document covers, e.g. "Budget & Timeline" / "الميزانية والجدول الزمني".
- doc_summary_en / doc_summary_ar: one sentence summarising the document.
- suggested_questions_en / suggested_questions_ar: two natural questions a reader could ask that this document answers.
- chunks: one entry for EVERY chunk id listed. "context" is one English sentence (max 35 words) that situates the chunk in the document: name the project or entity it is about and what the section covers, resolving vague references like "the project" or "this initiative". "keywords_en" and "keywords_ar" are 3-6 key terms each (Arabic translations or synonyms in keywords_ar).
Use only information present in the document. Do not invent numbers, names or dates.`;

export function docFullText(doc: StructuredDoc): string {
  return doc.sections
    .map((s) => [s.heading || s.title, ...s.blocks.map(renderBlock)].join("\n"))
    .join("\n\n");
}

export interface EnrichReport {
  status: "done" | "partial" | "skipped";
  reason?: string;
  model: string;
  ms: number;
  tokens: number;
  docs: { docId: string; labelEn: string; labelAr: string; summaryEn: string; summaryAr: string; status: string }[];
  chunks: { id: string; context: string; keywordsEn: string[]; keywordsAr: string[]; source: "llm" | "fallback" }[];
}

export async function enrichChunks(
  docs: StructuredDoc[],
  chunks: Chunk[],
): Promise<{ chunks: Chunk[]; profiles: DocProfile[]; suggested: { en: string[]; ar: string[] }; report: EnrichReport }> {
  const started = Date.now();
  const model = config.groq.enrichModel;
  let tokens = 0;
  const results = await Promise.allSettled(
    docs.map(async (doc) => {
      const docChunks = chunks.filter((c) => c.docId === doc.docId);
      const user = [
        `DOCUMENT: ${doc.title}${doc.subtitle ? ` — ${doc.subtitle}` : ""} (${doc.name})`,
        "",
        "FULL TEXT:",
        truncate(docFullText(doc), 14_000),
        "",
        "CHUNKS TO DESCRIBE:",
        ...docChunks.map((c) => `- ${c.id}: ${truncate(c.text.replace(/\s+/g, " "), 140)}`),
      ].join("\n");
      const res = await groqStructured<EnrichOut>({
        model,
        schemaName: "chunk_enrichment",
        schema: SCHEMA as unknown as Record<string, unknown>,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
        effort: "low",
        maxTokens: 2600,
        temperature: 0.2,
      });
      tokens += res.usage.total_tokens ?? 0;
      return { docId: doc.docId, out: res.data };
    }),
  );

  const byDoc = new Map<string, EnrichOut>();
  const failures: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") byDoc.set(r.value.docId, r.value.out);
    else failures.push(`${docs[i].docId}: ${(r.reason as Error)?.message ?? "error"}`);
  });

  const reportChunks: EnrichReport["chunks"] = [];
  const enriched = chunks.map((c) => {
    const e = byDoc.get(c.docId)?.chunks.find((x) => x.chunk_id.trim() === c.id);
    if (e && e.context.trim()) {
      const out = {
        ...c,
        context: truncate(e.context.trim(), 300),
        keywordsEn: e.keywords_en.map((k) => k.trim()).filter(Boolean).slice(0, 8),
        keywordsAr: e.keywords_ar.map((k) => k.trim()).filter(Boolean).slice(0, 8),
      };
      reportChunks.push({ id: c.id, context: out.context, keywordsEn: out.keywordsEn, keywordsAr: out.keywordsAr, source: "llm" });
      return out;
    }
    reportChunks.push({ id: c.id, context: c.context, keywordsEn: [], keywordsAr: [], source: "fallback" });
    return c;
  });

  const profiles: DocProfile[] = docs.map((d) => {
    const e = byDoc.get(d.docId);
    const fallbackLabel = (d.subtitle || d.title).replace(/\s+(document|breakdown)$/i, "");
    return {
      docId: d.docId,
      name: d.name,
      title: d.title,
      subtitle: d.subtitle,
      pageCount: d.pageCount,
      language: d.language,
      labelEn: e?.doc_label_en?.trim() || fallbackLabel,
      labelAr: e?.doc_label_ar?.trim() || fallbackLabel,
      summaryEn: e?.doc_summary_en?.trim() || "",
      summaryAr: e?.doc_summary_ar?.trim() || "",
      sections: d.sections.map((s) => ({ number: s.number, title: s.title, page: s.pageStart })),
    };
  });

  const suggested = {
    en: [...byDoc.values()].flatMap((e) => e.suggested_questions_en.slice(0, 2)).filter(Boolean).slice(0, 6),
    ar: [...byDoc.values()].flatMap((e) => e.suggested_questions_ar.slice(0, 2)).filter(Boolean).slice(0, 6),
  };

  const status: EnrichReport["status"] = byDoc.size === docs.length ? "done" : byDoc.size ? "partial" : "skipped";
  return {
    chunks: enriched,
    profiles,
    suggested,
    report: {
      status,
      reason: failures.length ? failures.join(" | ") : undefined,
      model,
      ms: Date.now() - started,
      tokens,
      docs: profiles.map((p) => ({ docId: p.docId, labelEn: p.labelEn, labelAr: p.labelAr, summaryEn: p.summaryEn, summaryAr: p.summaryAr, status: byDoc.has(p.docId) ? "llm" : "fallback" })),
      chunks: reportChunks,
    },
  };
}

/** Text used for BM25: same content as indexText() without the field labels,
 *  so words like "Document" or "Keywords" don't end up in every chunk's terms. */
export function bm25Text(c: Chunk): string {
  return [c.docSubtitle || c.docTitle, c.context, ...c.keywordsEn, ...c.keywordsAr, c.text].filter(Boolean).join("\n");
}

/** Text used for embedding and reranking (contextual header + chunk). */
export function indexText(c: Chunk): string {
  const kw = [...c.keywordsEn, ...c.keywordsAr].join(", ");
  return [
    `Document: ${c.docTitle}${c.docSubtitle ? ` — ${c.docSubtitle}` : ""}`,
    `Context: ${c.context}`,
    kw ? `Keywords: ${kw}` : "",
    "",
    c.text,
  ]
    .filter((l, i) => l !== "" || i === 3)
    .join("\n");
}
