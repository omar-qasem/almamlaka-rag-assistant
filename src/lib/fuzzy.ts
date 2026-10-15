// Deterministic quote verification: proves that a quote the LLM attributes to a
// source really occurs in that source. This is the groundedness check that runs
// without an extra LLM call.

import { normalizeForSearch, splitSentences, tokenize } from "./text";

export function normalizeForMatch(s: string): string {
  return normalizeForSearch(s)
    .replace(/[“”«»„"]/g, " ")
    .replace(/[–—−]/g, "-")
    .replace(/[^\p{L}\p{N}$%\- ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const numbersIn = (s: string) => (normalizeForMatch(s).match(/\d+(?:\.\d+)?/g) || []).map((n) => n.replace(/\.0+$/, ""));

export interface QuoteCheck {
  ok: boolean;
  score: number; // 0..1 coverage of the quote's words by a window of the source
  method: "exact" | "window" | "failed" | "empty";
}

/**
 * A quote is supported when (after normalisation) it appears verbatim, or a
 * window of the source covers >= 85% of its words in order-insensitive form —
 * tolerant to small punctuation/casing differences, strict on numbers:
 * every number in the quote must exist in the source.
 */
export function checkQuote(quote: string, source: string): QuoteCheck {
  const q = normalizeForMatch(quote);
  const src = normalizeForMatch(source);
  if (q.length < 4) return { ok: false, score: 0, method: "empty" };

  const srcNumbers = new Set(numbersIn(source));
  for (const n of numbersIn(quote)) {
    if (!srcNumbers.has(n)) return { ok: false, score: 0, method: "failed" };
  }

  if (src.includes(q)) return { ok: true, score: 1, method: "exact" };

  const qWords = q.split(" ");
  const sWords = src.split(" ");
  if (qWords.length < 3) return { ok: false, score: 0, method: "failed" };
  const win = Math.min(sWords.length, qWords.length + 4);
  let best = 0;
  for (let i = 0; i + win <= sWords.length || i === 0; i++) {
    const window = new Map<string, number>();
    for (const w of sWords.slice(i, i + win)) window.set(w, (window.get(w) || 0) + 1);
    let hit = 0;
    for (const w of qWords) {
      const c = window.get(w) || 0;
      if (c > 0) {
        hit++;
        window.set(w, c - 1);
      }
    }
    best = Math.max(best, hit / qWords.length);
    if (best === 1 || i + win >= sWords.length) break;
  }
  return { ok: best >= 0.85, score: Number(best.toFixed(2)), method: best >= 0.85 ? "window" : "failed" };
}

// ------------------------------------------------------------ quote repair
// Models sometimes cite the right source with a bad quote: translated into the
// answer's language, stitched from two places with "...", or paraphrased. The
// source is still the one the model chose, so the quote is replaced by the
// verbatim sentence of that source that best matches the quote and the answer.
// A quote whose numbers are not in the source is never repaired.

/** Citable units of a chunk: sentences of its paragraphs and rows of its tables. */
export function sourceUnits(text: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const units: string[] = [];
  lines.forEach((line, i) => {
    if (i === 0 && lines.length > 1) return; // section heading
    if (/^\|[\s|:-]+\|?$/.test(line)) return; // markdown table separator
    if (line.startsWith("|")) {
      units.push(line.replace(/^\|\s*|\s*\|$/g, "").replace(/\s*\|\s*/g, " | "));
      return;
    }
    for (const s of splitSentences(line)) if (s.split(/\s+/).length >= 2) units.push(s);
  });
  return units.length ? units : [text.trim()];
}

export interface RepairResult {
  quote: string;
  score: number;
}

/**
 * Best verbatim unit of `source` for a citation, using the model's quote and
 * related text (the answer sentences that cite the source, the model's
 * relevant fact, the English search query). Needs a real anchor: shared
 * numbers, or at least two shared content words.
 */
export function repairQuote(quote: string, source: string, related: string[]): RepairResult | null {
  const srcNumbers = new Set(numbersIn(source));
  const quoteNumbers = numbersIn(quote);
  if (quoteNumbers.some((n) => !srcNumbers.has(n))) return null;

  const qTok = new Set(tokenize(quote));
  const rTok = new Set(related.flatMap((r) => tokenize(r)));
  const anchors = new Set([...quoteNumbers, ...related.flatMap((r) => numbersIn(r))].filter((n) => srcNumbers.has(n)));

  let best: (RepairResult & { qHit: number; rHit: number; nHit: number }) | null = null;
  for (const unit of sourceUnits(source)) {
    const uTok = new Set(tokenize(unit));
    const uNum = new Set(numbersIn(unit));
    const qHit = [...qTok].filter((t) => uTok.has(t) && !/^\d+$/.test(t)).length;
    const rHit = [...rTok].filter((t) => uTok.has(t) && !/^\d+$/.test(t)).length;
    const nHit = [...anchors].filter((n) => uNum.has(n)).length;
    const score = qHit * 2 + rHit + nHit * 3;
    if (!best || score > best.score) best = { quote: unit, score, qHit, rHit, nHit };
  }
  if (!best) return null;
  const anchored = best.nHit >= 1 || best.qHit >= 2 || best.rHit >= 2;
  if (!anchored || best.score < 3) return null;
  const words = best.quote.split(/\s+/);
  return { quote: words.length > 45 ? `${words.slice(0, 45).join(" ")} …` : best.quote, score: best.score };
}
