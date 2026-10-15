// Okapi BM25 over the chunk index. Small corpora fit comfortably in the KB
// JSON, so the index is precomputed at ingestion and scored in memory.

import type { Bm25Index } from "../types";
import { tokenize } from "./text";

export function buildBm25(texts: string[], k1 = 1.2, b = 0.75): Bm25Index {
  const docs = texts.map((t) => {
    const tf: Record<string, number> = {};
    const toks = tokenize(t);
    for (const tok of toks) tf[tok] = (tf[tok] || 0) + 1;
    return { len: toks.length, tf };
  });
  const df: Record<string, number> = {};
  for (const d of docs) for (const term of Object.keys(d.tf)) df[term] = (df[term] || 0) + 1;
  const avgdl = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
  return { k1, b, avgdl, df, docs };
}

export function idf(index: Bm25Index, term: string): number {
  const N = index.docs.length;
  const n = index.df[term] || 0;
  return Math.log(1 + (N - n + 0.5) / (n + 0.5));
}

export function bm25Scores(index: Bm25Index, query: string): number[] {
  const terms = [...new Set(tokenize(query))];
  return index.docs.map((d) => {
    let s = 0;
    for (const term of terms) {
      const f = d.tf[term];
      if (!f) continue;
      const denom = f + index.k1 * (1 - index.b + (index.b * d.len) / (index.avgdl || 1));
      s += idf(index, term) * ((f * (index.k1 + 1)) / denom);
    }
    return Number(s.toFixed(4));
  });
}

export interface TermStat {
  term: string;
  df: number; // number of chunks containing the term
  idf: number;
}

const stat = (index: Bm25Index, t: string): TermStat => ({ term: t, df: index.df[t], idf: Number(idf(index, t).toFixed(3)) });

/** Most widespread terms (low weight). */
export function topTerms(index: Bm25Index, n = 12): TermStat[] {
  return Object.keys(index.df)
    .filter((t) => !/^\d+$/.test(t))
    .map((t) => stat(index, t))
    .sort((a, b) => b.df - a.df || a.term.localeCompare(b.term))
    .slice(0, n);
}

/** Rare, high-weight terms — amounts, dates and names are what BM25 adds over dense search. */
export function rareTerms(index: Bm25Index, n = 12): TermStat[] {
  const rare = Object.keys(index.df)
    .filter((t) => index.df[t] <= 2 && t.length >= 4)
    .map((t) => stat(index, t))
    .sort((a, b) => a.df - b.df || b.term.length - a.term.length || a.term.localeCompare(b.term));
  // half numbers (amounts, dates), half words (names, rare nouns)
  const numbers = rare.filter((t) => /\d/.test(t.term)).slice(0, Math.ceil(n / 2));
  const words = rare.filter((t) => !/\d/.test(t.term)).slice(0, n - numbers.length);
  return [...numbers, ...words];
}
