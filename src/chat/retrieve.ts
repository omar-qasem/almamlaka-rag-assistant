// Hybrid retrieval:
//   bilingual queries -> dense (Jina, cosine) + BM25 lists -> reciprocal rank fusion
//   -> Jina reranker -> top-k + per-document diversity + conflict expansion.

import { config } from "../config";
import { bm25Scores } from "../lib/bm25";
import { jinaEmbed, jinaRerank } from "../lib/jina";
import { decodeVector, dot } from "../lib/vector";
import { indexText } from "../ingest/enrich";
import type { Chunk, Conflict, KnowledgeBase } from "../types";

export interface Candidate {
  index: number;
  chunkId: string;
  docId: string;
  dense: number | null; // best cosine across query variants
  bm25: number; // best BM25 across query variants
  rrf: number;
  rerank: number | null;
  reason: "top-k" | "document diversity" | "conflict counterpart";
}

export interface RetrievalResult {
  selected: Candidate[];
  pool: Candidate[];
  hints: Conflict[];
  queries: string[];
  notes: string[];
  denseOk: boolean;
  rerankOk: boolean;
}

export interface RetrievalDeps {
  embed: typeof jinaEmbed;
  rerank: typeof jinaRerank;
}

const rankOrder = (scores: number[], positiveOnly: boolean) =>
  scores
    .map((s, i) => ({ s, i }))
    .filter((x) => !positiveOnly || x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, config.retrieval.perListTop)
    .map((x) => x.i);

export async function retrieve(
  kb: KnowledgeBase,
  input: { standalone: string; queryEn: string; queryAr: string },
  deps: RetrievalDeps = { embed: jinaEmbed, rerank: jinaRerank },
): Promise<RetrievalResult> {
  const { rrfK, poolSize, finalK, maxSources } = config.retrieval;
  const notes: string[] = [];
  const queries = [...new Set([input.queryEn, input.queryAr, input.standalone].map((q) => q?.trim()).filter(Boolean))].slice(0, 3) as string[];
  const vectors = kb.vectors.map(decodeVector);

  // Dense lists (one per query variant).
  let denseScores: number[][] = [];
  let denseOk = true;
  try {
    const { vectors: qv } = await deps.embed(queries, "retrieval.query");
    denseScores = qv.map((q) => vectors.map((v) => dot(q, v)));
  } catch (e) {
    denseOk = false;
    notes.push(`dense retrieval unavailable (${(e as Error).message.slice(0, 80)}); BM25 only`);
  }
  const bmScores = queries.map((q) => bm25Scores(kb.bm25, q));

  // Reciprocal rank fusion across all lists.
  const rrf = new Array(kb.chunks.length).fill(0);
  for (const scores of denseScores) rankOrder(scores, false).forEach((idx, rank) => (rrf[idx] += 1 / (rrfK + rank + 1)));
  for (const scores of bmScores) rankOrder(scores, true).forEach((idx, rank) => (rrf[idx] += 1 / (rrfK + rank + 1)));

  const best = (lists: number[][], i: number) => (lists.length ? Math.max(...lists.map((l) => l[i])) : null);
  const all: Candidate[] = kb.chunks.map((c, i) => ({
    index: i,
    chunkId: c.id,
    docId: c.docId,
    dense: denseOk ? Number((best(denseScores, i) ?? 0).toFixed(4)) : null,
    bm25: Number((best(bmScores, i) ?? 0).toFixed(3)),
    rrf: Number(rrf[i].toFixed(5)),
    rerank: null,
    reason: "top-k",
  }));
  let pool = all.filter((c) => c.rrf > 0).sort((a, b) => b.rrf - a.rrf).slice(0, poolSize);
  if (!pool.length) pool = all.slice(0, Math.min(poolSize, all.length));

  // Rerank the fused pool against the question in the corpus language.
  let rerankOk = true;
  const rerankQuery = (kb.corpusLanguage === "ar" ? input.queryAr : input.queryEn) || input.standalone;
  try {
    const { results } = await deps.rerank(rerankQuery, pool.map((c) => indexText(kb.chunks[c.index])), pool.length);
    for (const r of results) pool[r.index].rerank = r.score;
    pool.sort((a, b) => (b.rerank ?? -1) - (a.rerank ?? -1) || b.rrf - a.rrf);
  } catch (e) {
    rerankOk = false;
    notes.push(`reranker unavailable (${(e as Error).message.slice(0, 80)}); using fused order`);
  }

  const selected: Candidate[] = pool.slice(0, finalK).map((c) => ({ ...c, reason: "top-k" }));
  const has = (id: string) => selected.some((s) => s.chunkId === id);
  const topScore = pool[0]?.rerank ?? null;

  // Document diversity: every document that has a reasonably relevant chunk gets
  // a seat, so contradicting documents are both visible to the generator.
  for (const doc of kb.docs) {
    if (selected.length >= maxSources) break;
    if (selected.some((s) => s.docId === doc.docId)) continue;
    const cand = pool.find((c) => c.docId === doc.docId);
    if (!cand) continue;
    const relevant = rerankOk && topScore !== null && cand.rerank !== null ? cand.rerank >= Math.max(0.02, topScore * 0.3) : pool.indexOf(cand) < 7;
    if (relevant) selected.push({ ...cand, reason: "document diversity" });
  }

  // Conflict expansion: if a top chunk takes part in a known discrepancy, bring
  // in the other side(s) and pass the registry entry as a hint.
  const hints: Conflict[] = [];
  const head = new Set(selected.slice(0, 3).map((s) => s.chunkId));
  for (const conflict of kb.conflicts) {
    if (!conflict.claims.some((cl) => head.has(cl.chunkId))) continue;
    hints.push(conflict);
    for (const cl of conflict.claims) {
      if (has(cl.chunkId) || selected.length >= maxSources) continue;
      const idx = kb.chunks.findIndex((c) => c.id === cl.chunkId);
      if (idx < 0) continue;
      const existing = all[idx];
      selected.push({ ...existing, rerank: pool.find((p) => p.index === idx)?.rerank ?? null, reason: "conflict counterpart" });
    }
  }

  return { selected, pool, hints, queries, notes, denseOk, rerankOk };
}

export const chunkLabel = (c: Chunk) => `${c.sectionNumber ? `${c.sectionNumber}. ` : ""}${c.sectionTitle}`;
