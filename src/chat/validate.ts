// Code-level checks on the generator's structured answer. Nothing reaches the
// user unless it is backed by a quote that really exists in a retrieved source.

import { checkQuote, repairQuote } from "../lib/fuzzy";
import { arabicLetterShare, toAsciiDigits } from "../lib/text";
import type { Lang } from "../types";
import type { AnswerOut } from "./prompts";

export interface SourceRef {
  sid: string; // S1..Sn as shown to the model
  chunkId: string;
  docId: string;
  docLabel: string;
  docName: string;
  section: string;
  pageStart: number;
  pageEnd: number;
  text: string;
  reason: string;
}

export interface VerifiedCitation {
  sid: string;
  chunkId: string;
  docId: string;
  docLabel: string;
  docName: string;
  section: string;
  pageStart: number;
  pageEnd: number;
  quote: string;
  match: "exact" | "window" | "repaired";
}

export interface VerifiedConflict {
  topic: string;
  crossDocument: boolean;
  positions: { sid: string; docId: string; docLabel: string; pageStart: number; section: string; claim: string }[];
}

export interface Validation {
  ok: boolean;
  blocking: string[]; // problems that force a retry
  warnings: string[]; // fixed silently (e.g. dropped an unverifiable quote)
  answer: string;
  citations: VerifiedCitation[];
  conflicts: VerifiedConflict[];
  languageShare: number;
  repaired: number; // quotes replaced by the closest verbatim sentence of their source
}

/** "S2", "[S2]", "【S2】", "S٢", " s2 " -> "S2" */
const sidOf = (raw: string) =>
  toAsciiDigits(raw)
    .trim()
    .replace(/^[\[【(]\s*|\s*[\]】)]$/g, "")
    .replace(/†.*$/, "")
    .replace(/^(?:source|المصدر)\s*/i, "")
    .trim()
    .toUpperCase();

/**
 * Canonical markers. Models — gpt-oss in particular — also write "【S1】",
 * "【S1†L2-L4】", "[S1, S3]", "(S2)", "[s2]" or Arabic-Indic digits ("[S١]").
 * All of them become "[S1]", "[S1][S3]", "[S2]".
 */
export function normalizeMarkers(text: string): string {
  const ids = (list: string) =>
    list
      .split(/\s*[,،;]\s*/)
      .map((id) => `[${toAsciiDigits(id).replace(/\s+/g, "").toUpperCase()}]`)
      .join("");
  return text
    .replace(/[\[【]\s*([sS]\s?[\d٠-٩]+(?:\s*[,،;]\s*[sS]\s?[\d٠-٩]+)*)\s*(?:†[^\]】]*)?[\]】]/g, (_m, list: string) => ids(list))
    .replace(/\(\s*([sS][\d٠-٩]+(?:\s*[,،;]\s*[sS][\d٠-٩]+)*)\s*\)/g, (_m, list: string) => ids(list));
}

export interface ValidationContext {
  related?: string[]; // extra text that helps locate a citation in its source (e.g. the English search query)
}

/** The text just before each [sid] marker: the claim that marker supports. */
const claimsFor = (answer: string, sid: string) => {
  const out: string[] = [];
  const re = new RegExp(`\\[${sid}\\]`, "g");
  for (let m = re.exec(answer); m; m = re.exec(answer)) out.push(answer.slice(Math.max(0, m.index - 260), m.index));
  return out;
};

export function validateAnswer(draft: AnswerOut, sources: SourceRef[], lang: Lang, ctx: ValidationContext = {}): Validation {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const bySid = new Map(sources.map((s) => [s.sid, s]));
  let repaired = 0;

  if (draft.status === "not_found") {
    return { ok: true, blocking, warnings, answer: "", citations: [], conflicts: [], languageShare: 0, repaired };
  }

  let answer = normalizeMarkers((draft.answer || "").trim());
  const factFor = (sid: string) => (draft.facts_by_source || []).filter((f) => sidOf(f.source_id) === sid).map((f) => f.relevant_fact);
  // Evidence for locating a citation: the claims that cite the source and the
  // model's own note on it; the search query only helps repair a quote the model
  // did give, never invent a citation for a bare marker.
  const evidence = (sid: string) => [...claimsFor(answer, sid), ...factFor(sid)];

  const citations: VerifiedCitation[] = [];
  const rejected = new Set<string>();
  const addCitation = (src: SourceRef, quote: string, match: VerifiedCitation["match"]) => {
    if (citations.some((x) => x.sid === src.sid && x.quote === quote)) return;
    citations.push({
      sid: src.sid,
      chunkId: src.chunkId,
      docId: src.docId,
      docLabel: src.docLabel,
      docName: src.docName,
      section: src.section,
      pageStart: src.pageStart,
      pageEnd: src.pageEnd,
      quote,
      match,
    });
  };

  // 1) citations: known source + quote really present in that source. A quote
  //    that is not verbatim (translated, stitched with "...", paraphrased) is
  //    replaced by the closest verbatim sentence of the same source, if one is
  //    clearly anchored; otherwise it is dropped.
  for (const c of draft.citations || []) {
    const sid = sidOf(c.source_id);
    const src = bySid.get(sid);
    if (!src) {
      warnings.push(`citation to unknown source ${sid} removed`);
      continue;
    }
    const check = checkQuote(c.quote, src.text);
    if (check.ok) {
      addCitation(src, c.quote.trim(), check.method === "exact" ? "exact" : "window");
      continue;
    }
    const fix = repairQuote(c.quote, src.text, [...evidence(sid), ...(ctx.related ?? [])]);
    if (fix) {
      repaired++;
      addCitation(src, fix.quote, "repaired");
      warnings.push(`quote for ${sid} was not verbatim; replaced by the closest sentence of that source`);
    } else {
      rejected.add(sid);
      warnings.push(`quote attributed to ${sid} is not in that source: "${c.quote.slice(0, 80)}"`);
    }
  }

  // 2) markers in the answer must point to sources with a verified quote. A
  //    marker whose citation entry was forgotten gets one from its source when
  //    the answer sentence is clearly anchored there; otherwise it is removed.
  //    A source whose quote was rejected (e.g. invented numbers) gets no second chance.
  for (const m of new Set([...answer.matchAll(/\[(S\d+)\]/g)].map((x) => x[1]))) {
    if (citations.some((c) => c.sid === m)) continue;
    const src = bySid.get(m);
    const fix = src && !rejected.has(m) ? repairQuote("", src.text, evidence(m)) : null;
    if (src && fix) {
      repaired++;
      addCitation(src, fix.quote, "repaired");
      warnings.push(`marker [${m}] had no citation entry; quoted the closest sentence of that source`);
    } else {
      warnings.push(`marker [${m}] has no verified quote and was removed`);
      answer = answer.replaceAll(`[${m}]`, "");
    }
  }
  answer = answer.replace(/\s+([.,،؛:])/g, "$1").replace(/ {2,}/g, " ").trim();

  // 3) verified citations but no markers in the text: attach them at the end
  //    rather than discarding a grounded answer.
  if (answer && citations.length && !/\[S\d+\]/.test(answer)) {
    answer = `${answer} ${[...new Set(citations.map((c) => `[${c.sid}]`))].join("")}`;
    warnings.push("the answer had no markers; its cited sources were attached at the end");
  }

  if (!answer) blocking.push("the answer text is empty although status is not \"not_found\"");
  if (!citations.length) blocking.push("no citation has a quote that appears verbatim in its source");

  // 4) language — proper nouns / acronyms kept in Latin script (names, DEI, MAU)
  //    and inline quotations of the English sources are ignored, so an Arabic
  //    answer that names people or quotes a document still counts as Arabic.
  const share = arabicLetterShare(
    answer.replace(/“[^”]*”|"[^"]*"|«[^»]*»/g, " ").replace(/\b[A-Z][A-Za-z'’-]*\b/g, " "),
  );
  if (answer && lang === "ar" && share < 0.35) blocking.push("the answer must be written in Arabic");
  if (answer && lang === "en" && share > 0.25) blocking.push("the answer must be written in English");

  // 5) conflicts: keep positions with valid sources, need >= 2 distinct sources
  const conflicts: VerifiedConflict[] = [];
  for (const c of draft.conflicts || []) {
    const positions = (c.positions || [])
      .map((p) => ({ p, src: bySid.get(sidOf(p.source_id)) }))
      .filter((x): x is { p: (typeof c.positions)[number]; src: SourceRef } => !!x.src)
      .map(({ p, src }) => ({ sid: src.sid, docId: src.docId, docLabel: src.docLabel, pageStart: src.pageStart, section: src.section, claim: p.claim.trim() }));
    // Two distinct statements are required; they may come from one source when a
    // document contradicts itself (crossDocument=false is shown as an internal inconsistency).
    if (new Set(positions.map((p) => `${p.sid}|${p.claim.toLowerCase()}`)).size < 2) {
      if (c.positions?.length) warnings.push(`conflict "${c.topic}" dropped: fewer than two valid positions`);
      continue;
    }
    conflicts.push({ topic: c.topic.trim(), crossDocument: new Set(positions.map((p) => p.docId)).size > 1, positions });
  }

  return { ok: blocking.length === 0, blocking, warnings, answer, citations, conflicts, languageShare: Number(share.toFixed(2)), repaired };
}
