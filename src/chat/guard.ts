// Deterministic first line of defence: length cap, language detection and a
// pattern scan for well-known prompt-injection phrasing (English + Arabic,
// including Levantine wording). A match is a signal passed to the router; it is
// also the decision used if the router LLM is unavailable.

import { config } from "../config";
import { detectLanguage, normalizeArabic } from "../lib/text";
import type { Lang } from "../types";

const PATTERNS: { id: string; re: RegExp }[] = [
  { id: "ignore-instructions", re: /\b(ignore|disregard|forget|override|bypass)\b[^.?!]{0,40}\b(instruction|instructions|rules|prompt|prompts|guidelines|context|directions)\b/i },
  { id: "reveal-prompt", re: /\b(reveal|show|print|repeat|leak|display|output)\b[^.?!]{0,30}\b(system|hidden|initial|original)?\s*(prompt|instructions|rules|configuration)\b/i },
  { id: "role-change", re: /\b(you are now|from now on you|act as|pretend (?:to be|you are)|roleplay|role-play|jailbreak|dan mode|developer mode)\b/i },
  { id: "ar-ignore", re: /(تجاهل|انس|أنس|اترك|لا تلتزم|تخط|تخطى)[^.؟!]{0,30}(التعليمات|الاوامر|الأوامر|القواعد|التوجيهات|القيود|البرومبت)/ },
  { id: "ar-reveal", re: /(اكشف|اعرض|اطبع|كرر|ورجيني|وريني|احكيلي)[^.؟!]{0,25}(التعليمات|البرومبت|الاوامر|الأوامر|التوجيهات)/ },
  { id: "ar-role", re: /(انت الان|أنت الآن|من الان انت|تصرف ك|تقمص|العب دور)/ },
];

export interface GuardResult {
  message: string;
  truncated: boolean;
  language: Lang;
  arabicShare: number;
  suspicious: string[];
}

export function guardInput(raw: string): GuardResult {
  const max = config.limits.maxMessageChars;
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  const message = cleaned.length > max ? cleaned.slice(0, max) : cleaned;
  const { lang, arabicShare } = detectLanguage(message);
  const normalized = normalizeArabic(message);
  const suspicious = PATTERNS.filter((p) => p.re.test(message) || p.re.test(normalized)).map((p) => p.id);
  return { message, truncated: cleaned.length > max, language: lang, arabicShare, suspicious };
}
