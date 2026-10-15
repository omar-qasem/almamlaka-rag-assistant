// Text utilities shared by ingestion, BM25 and validation.
// Arabic + English aware, dependency-free.

import type { Lang } from "../types";

export const ARABIC_CHAR = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const ARABIC_CHAR_G = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;
const LATIN_WORD_G = /[A-Za-z][A-Za-z'’-]*/g;
const ARABIC_WORD_G = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+/g;

const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const ZERO_WIDTH = /[​-‏‪-‮⁦-⁩﻿]/g;
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;

/** Unicode-normalise (fixes Arabic presentation forms such as ﻻ) and strip invisible marks. */
export function cleanUnicode(s: string): string {
  return s.normalize("NFKC").replace(ZERO_WIDTH, "").replace(/ /g, " ");
}

/** Standard light Arabic normalisation used in Arabic IR. */
export function normalizeArabic(s: string): string {
  return s
    .replace(TASHKEEL, "")
    .replace(TATWEEL, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

export function toAsciiDigits(s: string): string {
  return s.replace(ARABIC_INDIC_DIGITS, (d) => {
    const code = d.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** Lower-case, Arabic-normalised, digits unified, thousands separators removed. */
export function normalizeForSearch(s: string): string {
  return normalizeArabic(toAsciiDigits(cleanUnicode(s)).toLowerCase())
    .replace(/(\d)[,٬](?=\d{3}\b)/g, "$1")
    .replace(/[’‘`]/g, "'");
}

/** Language of a user message by word counts — robust to Arabic sentences that
 *  contain English names ("شو ميزانية مشروع Digital Expansion؟" -> ar). */
export function detectLanguage(text: string): { lang: Lang; arabicShare: number } {
  const ar = (text.match(ARABIC_WORD_G) || []).length;
  const la = (text.match(LATIN_WORD_G) || []).length;
  if (ar + la === 0) return { lang: "en", arabicShare: 0 };
  const share = ar / (ar + la);
  return { lang: share >= 0.4 ? "ar" : "en", arabicShare: share };
}

/** Share of letters that are Arabic (used to check the answer language). */
export function arabicLetterShare(text: string): number {
  const ar = (text.match(ARABIC_CHAR_G) || []).length;
  const la = (text.replace(/\[S\d+\]/g, "").match(/[A-Za-z]/g) || []).length;
  return ar + la === 0 ? 0 : ar / (ar + la);
}

/** Cheap token estimate (no tokenizer download in a serverless function).
 *  Calibrated loosely on BPE tokenizers: ~1.3 tokens per English word,
 *  ~2 per Arabic word, numbers and symbols counted separately. */
export function estimateTokens(text: string): number {
  const latin = (text.match(LATIN_WORD_G) || []).length;
  const arabic = (text.match(ARABIC_WORD_G) || []).length;
  const numbers = (text.match(/\d[\d,.]*/g) || []).length;
  const symbols = (text.match(/[^\s\w؀-ۿ]/g) || []).length;
  return Math.max(1, Math.ceil(latin * 1.3 + arabic * 2 + numbers * 1.5 + symbols * 0.4));
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?؟؛])\s+(?=\S)/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");

// ---------------------------------------------------------------- tokenizer

const STOP_EN = new Set(
  (
    "a an the and or but if then else of to in on at by for with about as from into over under is are was were be been being " +
    "this that these those it its it's he she they them his her their our we you your i me my what which who whom whose when " +
    "where why how do does did done have has had will would shall should can could may might must not no yes so than too very " +
    "there here also any all each other such only own same just more most some few both up down out off again further once " +
    "please tell show give me us let know"
  ).split(/\s+/),
);

const STOP_AR = new Set(
  normalizeArabic(
    "في من الى إلى على عن مع هذا هذه ذلك تلك هو هي هم هن انا أنا نحن انت أنت ما ماذا متى اين أين كيف لماذا هل كم أي اي " +
      "التي الذي الذين اللتي ثم او أو و ف ب ل ك قد كان كانت يكون تكون لم لن لا نعم بعد قبل عند كل بعض غير بين حتى اذا إذا " +
      "شو ايش وين ليش قديش هاد هاي هذاك اللي يا عن هل تم وما ومن وفي وهل وكم وماذا فما فهل ولا ولم ومتى وكيف طيب",
  ).split(/\s+/),
);

function stemEn(t: string): string {
  if (t.length > 5 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed") && !t.endsWith("eed")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us")) return t.slice(0, -1);
  return t;
}

const AR_PREFIXES = ["وال", "بال", "كال", "فال", "لل", "ال"];
const AR_SUFFIXES = ["هما", "كما", "ها", "هم", "هن", "كم", "نا", "ات", "ون", "ين", "يه", "ه"];
function stemAr(t: string): string {
  let w = t;
  for (const p of AR_PREFIXES) {
    if (w.startsWith(p) && w.length - p.length >= 3) {
      w = w.slice(p.length);
      break;
    }
  }
  for (const s of AR_SUFFIXES) {
    if (w.endsWith(s) && w.length - s.length >= 3) {
      w = w.slice(0, -s.length);
      break;
    }
  }
  return w;
}

/** Tokenizer for BM25: normalised, stop-words removed, light stemming. */
export function tokenize(text: string): string[] {
  const norm = normalizeForSearch(text);
  const raw = norm.split(/[^\p{L}\p{N}$%]+/u).filter(Boolean);
  const out: string[] = [];
  for (let t of raw) {
    t = t.replace(/^\$+/, "");
    if (!t) continue;
    if (/^\d+$/.test(t)) {
      out.push(t);
      continue;
    }
    if (ARABIC_CHAR.test(t)) {
      if (STOP_AR.has(t) || t.length < 2) continue;
      out.push(stemAr(t));
    } else {
      if (STOP_EN.has(t) || t.length < 2) continue;
      out.push(stemEn(t));
    }
  }
  return out;
}
