// Stage 8 — Conflict audit at ingestion time.
// An LLM compares facts across chunks once, up front. Every claim it reports is
// verified in code (the quote must exist in the cited chunk), so the registry
// only holds provable discrepancies. At question time the registry pulls the
// "other side" of a known conflict into the context, so the answer can flag it
// even when retrieval would have surfaced only one document.

import { config } from "../config";
import { groqStructured } from "../lib/groq";
import { checkQuote, normalizeForMatch, numbersIn } from "../lib/fuzzy";
import { estimateTokens, truncate } from "../lib/text";
import type { Chunk, Conflict, ConflictClaim } from "../types";

const SCHEMA = {
  type: "object",
  properties: {
    conflicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic_en: { type: "string" },
          topic_ar: { type: "string" },
          attribute: { type: "string" },
          kind: { type: "string", enum: ["value_mismatch", "revision", "logical_inconsistency"] },
          claims: {
            type: "array",
            items: {
              type: "object",
              properties: {
                chunk_id: { type: "string" },
                value: { type: "string" },
                quote: { type: "string" },
              },
              required: ["chunk_id", "value", "quote"],
              additionalProperties: false,
            },
          },
          explanation_en: { type: "string" },
          explanation_ar: { type: "string" },
        },
        required: ["topic_en", "topic_ar", "attribute", "kind", "claims", "explanation_en", "explanation_ar"],
        additionalProperties: false,
      },
    },
  },
  required: ["conflicts"],
  additionalProperties: false,
} as const;

interface ConflictOut {
  conflicts: {
    topic_en: string;
    topic_ar: string;
    attribute: string;
    kind: Conflict["kind"];
    claims: { chunk_id: string; value: string; quote: string }[];
    explanation_en: string;
    explanation_ar: string;
  }[];
}

const SYSTEM = `You audit document chunks for factual discrepancies.
Report cases where chunks state DIFFERENT values for the SAME attribute of the SAME entity: total budget, launch or release date, deadlines, durations, counts, the person holding a role, and similar facts. Kinds:
- "revision": one chunk states an updated value and explicitly mentions the change (revised, adjusted, moved, postponed), while another chunk still states the old value;
- "value_mismatch": two chunks give different values and nothing explains the difference;
- "logical_inconsistency": values that cannot both hold (for example a launch date that falls before the end of a testing phase that must precede it).
Do NOT report complementary details, different attributes, or facts that only one chunk mentions.
For each discrepancy return topic_en and topic_ar (short), the attribute, the kind, at least two claims (chunk_id, "value" written exactly as it appears in the quote, and "quote": 5-30 words copied exactly from that chunk), and a one-sentence explanation in English and Arabic.
Return an empty "conflicts" array if there are none. Never invent values.`;

export interface ConflictReport {
  status: "done" | "skipped";
  reason?: string;
  model: string;
  ms: number;
  tokens: number;
  inputChunks: number;
  proposed: number;
  rejected: { topic: string; reason: string }[];
  conflicts: Conflict[];
}

const sameValue = (a: string, b: string) => normalizeForMatch(a) === normalizeForMatch(b);

export async function mineConflicts(chunks: Chunk[]): Promise<{ conflicts: Conflict[]; report: ConflictReport }> {
  const started = Date.now();
  const model = config.groq.conflictModel;
  const base: ConflictReport = { status: "done", model, ms: 0, tokens: 0, inputChunks: 0, proposed: 0, rejected: [], conflicts: [] };
  if (new Set(chunks.map((c) => c.docId)).size < 1 || chunks.length < 2) {
    return { conflicts: [], report: { ...base, status: "skipped", reason: "Not enough chunks to compare" } };
  }

  // Keep the prompt bounded on large uploads: prefer fact-bearing chunks (numbers, dates).
  let candidates = chunks;
  const budget = 9000;
  if (chunks.reduce((n, c) => n + c.tokens, 0) > budget) {
    candidates = chunks.filter((c) => /\d/.test(c.text));
    let used = 0;
    candidates = candidates.filter((c) => (used += Math.min(c.tokens, 300)) <= budget);
  }
  const user =
    "CHUNKS:\n\n" +
    candidates
      .map((c) => `[${c.id}] (document: ${c.docSubtitle || c.docTitle}; page ${c.pageStart}; section: ${c.sectionNumber ? `${c.sectionNumber}. ` : ""}${c.sectionTitle})\n${truncate(c.text, 1400)}`)
      .join("\n\n");

  let data: ConflictOut;
  try {
    const res = await groqStructured<ConflictOut>({
      model,
      schemaName: "conflict_audit",
      schema: SCHEMA as unknown as Record<string, unknown>,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      effort: config.groq.reasoningEffort === "low" ? "medium" : config.groq.reasoningEffort,
      maxTokens: 3500,
      temperature: 0.2,
      timeoutMs: 35_000,
    });
    data = res.data;
    base.tokens = res.usage.total_tokens ?? estimateTokens(user);
  } catch (e) {
    return { conflicts: [], report: { ...base, status: "skipped", reason: (e as Error).message, ms: Date.now() - started, inputChunks: candidates.length } };
  }

  const byId = new Map(chunks.map((c) => [c.id, c]));
  const conflicts: Conflict[] = [];
  const rejected: ConflictReport["rejected"] = [];
  for (const c of data.conflicts || []) {
    const claims: ConflictClaim[] = [];
    for (const cl of c.claims || []) {
      const chunk = byId.get(cl.chunk_id?.trim());
      if (!chunk) continue;
      const q = checkQuote(cl.quote, chunk.text);
      if (!q.ok) continue;
      // The value must be stated in the quote itself (every number in it).
      const value = cl.value?.trim();
      if (!value) continue;
      const quoteNumbers = new Set(numbersIn(cl.quote));
      if (numbersIn(value).some((n) => !quoteNumbers.has(n))) continue;
      claims.push({ chunkId: chunk.id, docId: chunk.docId, value: cl.value.trim(), quote: cl.quote.trim(), page: chunk.pageStart });
    }
    const distinctChunks = new Set(claims.map((x) => x.chunkId));
    const distinctClaims = new Set(claims.map((x) => `${x.chunkId}|${normalizeForMatch(x.quote)}`));
    const distinctValues = new Set(claims.map((x) => normalizeForMatch(x.value)));
    // value mismatches / revisions need two chunks; a logical inconsistency may sit
    // inside one chunk (e.g. a timeline table whose launch precedes its QA end date).
    const enough = c.kind === "logical_inconsistency" ? distinctClaims.size >= 2 : distinctChunks.size >= 2;
    if (!enough) {
      rejected.push({ topic: c.topic_en, reason: "fewer than two verifiable claims" });
      continue;
    }
    if (c.kind !== "logical_inconsistency" && distinctValues.size < 2) {
      rejected.push({ topic: c.topic_en, reason: "claims state the same value" });
      continue;
    }
    // drop duplicate claims that repeat the same value from the same document
    const unique = claims.filter((x, i) => claims.findIndex((y) => y.docId === x.docId && sameValue(y.value, x.value)) === i);
    conflicts.push({
      id: `C${conflicts.length + 1}`,
      topicEn: c.topic_en.trim(),
      topicAr: c.topic_ar.trim(),
      attribute: c.attribute.trim(),
      kind: c.kind,
      crossDocument: new Set(unique.map((x) => x.docId)).size > 1,
      claims: unique,
      explanationEn: c.explanation_en.trim(),
      explanationAr: c.explanation_ar.trim(),
    });
  }

  return {
    conflicts,
    report: { ...base, ms: Date.now() - started, inputChunks: candidates.length, proposed: (data.conflicts || []).length, rejected, conflicts },
  };
}
