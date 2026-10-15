// Offline stand-in for the Groq and Jina HTTP APIs, used by the test suite and
// by `npm run dev:mock`. It speaks the same wire format as the real services so
// the production HTTP clients, schemas and graph wiring are exercised end to end.
// The "model" behaviour is simple keyword logic — it tests plumbing, not quality.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { tokenize } from "../src/lib/text";

export interface MockState {
  calls: { path: string; schema?: string }[];
  failRerank: boolean;
  failEmbed: boolean;
  rateLimitSchema: string | null; // respond 429 for this schema
  fabricateQuotes: boolean; // generator returns quotes that are not in the sources
  modelQuirks: boolean; // gpt-oss habits: 【S1†L1-L2】 markers and translated quotes in Arabic answers
}

const AR_EN_RAW: Record<string, string> = {
  ميزانية: "budget", الميزانية: "budget", ميزانيته: "budget", تكلفة: "budget", موازنة: "budget",
  إطلاق: "launch", الإطلاق: "launch", إطلاقه: "launch", موعد: "date", تاريخ: "date",
  فريق: "team", الفريق: "team", مهندس: "engineer", المهندس: "engineer", قسم: "department", قسمه: "department",
  قائد: "lead", مدير: "lead", مسؤول: "lead", لغات: "languages", اللغات: "languages",
  الخصوصية: "privacy", خصوصية: "privacy", مخاطر: "risk", المخاطر: "risk", الحوكمة: "governance", منصات: "platforms",
};
// Keys go through the same normaliser/stemmer as the text so lookups match.
const AR_EN: Record<string, string> = Object.fromEntries(
  Object.entries(AR_EN_RAW).flatMap(([ar, en]) => tokenize(ar).map((t) => [t, en] as const)),
);
const EN_AR: Record<string, string> = { budget: "ميزانية", launch: "إطلاق", date: "موعد", team: "فريق", engineer: "مهندس", department: "قسم", lead: "قائد", project: "المشروع", languages: "لغات", privacy: "الخصوصية", risk: "المخاطر" };
const GENERIC = new Set(["almamlaka", "tv", "channel", "project", "initiative", "digital", "expansion", "dei", "document", "about", "regarding"]);

function enTokens(text: string): string[] {
  return tokenize(text).map((t) => AR_EN[t] ?? t);
}

function hashVec(text: string, dims: number): number[] {
  const v = new Array(dims).fill(0);
  for (const t of enTokens(text)) {
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
    const idx = Math.abs(h) % dims;
    v[idx] += h & 1 ? 1 : -1;
    v[(idx * 7 + 3) % dims] += 0.5;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

const isArabic = (s: string) => /[؀-ۿ]/.test(s) && (s.match(/[؀-ۿ]/g) || []).length > (s.match(/[A-Za-z]/g) || []).length * 0.4;

// ------------------------------------------------------------ fake "models"

function analyze(user: string) {
  const msg = (user.split("<<<\n")[1] || "").split("\n>>>")[0].trim();
  const historyStandalones = [...user.matchAll(/\[user\] (.*)/g)].map((m) => m[1]);
  const lower = msg.toLowerCase();
  let intent = "document_question";
  if (/ignore|disregard|system prompt|reveal your|تجاهل|انس|انسى/.test(lower)) intent = "prompt_injection";
  else if (/joke|نكت|weather|طقس|poem|قصيد|capital of|عاصمة|football|كرة القدم/.test(lower)) intent = "off_topic";
  else if (/^(hi|hello|hey|thanks|thank you|مرحبا|اهلا|أهلا|السلام|شكرا)\b/.test(lower)) intent = "greeting";
  let standalone = msg;
  if (intent === "document_question" && historyStandalones.length && /\b(its|it|his|her|their|that one)\b|ميزانيته|قسمه|موعده|وماذا عن|طيب و/.test(lower)) {
    standalone = `${msg} (regarding: ${historyStandalones[historyStandalones.length - 1]})`;
  }
  const toks = enTokens(standalone).filter((t) => !GENERIC.has(t));
  return {
    intent,
    language: isArabic(msg) ? "ar" : "en",
    standalone_question: standalone,
    query_en: toks.join(" ") || standalone,
    query_ar: toks.map((t) => EN_AR[t] ?? t).join(" "),
    reason: "mock",
  };
}

function parseSources(user: string) {
  return [...user.matchAll(/<source id="(S\d+)" document="([^"]*)" page="([^"]*)" section="([^"]*)">\n([\s\S]*?)\n<\/source>/g)].map((m) => ({ sid: m[1], doc: m[2], text: m[5] }));
}

function grounded(user: string, state: MockState) {
  const question = (user.match(/^QUESTION: (.*)$/m) || [])[1] || "";
  const arabic = /ANSWER LANGUAGE: Arabic/.test(user);
  const sources = parseSources(user);
  const qTok = new Set(enTokens(question).filter((t) => !GENERIC.has(t)));
  const scored = sources
    .map((s) => {
      const lines = s.text.split("\n").slice(1).flatMap((l) => (l.startsWith("|") ? [l] : l.split(/(?<=\.)\s+/)));
      let best = { line: "", score: 0 };
      for (const l of lines) {
        const score = enTokens(l).filter((t) => qTok.has(t)).length;
        if (score > best.score) best = { line: l, score };
      }
      return { ...s, ...best };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (!scored.length) return { facts_by_source: [], conflicts: [], status: "not_found", answer: "", citations: [] };

  const quoteOf = (line: string) => line.split(/\s+/).slice(0, 25).join(" ");
  // A "translated" quote keeps only the figures of the line, as real models do.
  const translated = (line: string) => `تنص الوثيقة على ما يلي ${(line.match(/\$[\d,]+|\d{1,2}, \d{4}|\d+%/g) || []).join(" ")}`.trim();
  const citations = scored.map((s) => ({
    source_id: state.modelQuirks ? `【${s.sid}】` : s.sid,
    quote: state.fabricateQuotes ? "The budget was approved by the board in 2019 for 9 million dollars" : state.modelQuirks && arabic ? translated(s.line) : quoteOf(s.line),
  }));
  const mark = (sid: string) => (state.modelQuirks ? `【${sid}†L1-L2】` : `[${sid}]`);
  const all = scored.map((s) => s.line).join(" ");
  const conflicts = [];
  const money = scored.filter((s) => /\$2,[46]00,000/.test(s.line));
  if (qTok.has("budget") && new Set(money.map((s) => s.line.match(/\$2,[46]00,000/)![0])).size > 1) {
    conflicts.push({ topic: arabic ? "إجمالي الميزانية" : "Total budget", positions: money.map((s) => ({ source_id: s.sid, claim: s.line.match(/\$2,[46]00,000/)![0] })) });
  }
  const dates = scored.filter((s) => /(March 15|April 1), 2027/.test(s.line));
  if (qTok.has("launch") && new Set(dates.map((s) => s.line.match(/(March 15|April 1), 2027/)![0])).size > 1) {
    conflicts.push({ topic: arabic ? "موعد الإطلاق" : "Launch date", positions: dates.map((s) => ({ source_id: s.sid, claim: s.line.match(/(March 15|April 1), 2027/)![0] })) });
  }
  const answer = arabic
    ? scored.map((s) => `تذكر الوثيقة ما يتعلق بسؤالك في هذا المقطع ${(s.line.match(/\$[\d,]+|\d{1,2}, \d{4}/) || [""])[0]} ${mark(s.sid)}.`).join(" ") + (conflicts.length ? " وتوجد معلومات متعارضة بين الوثائق." : "")
    : scored.map((s) => `${s.line.replace(/\s*\|\s*/g, " ").trim()} ${mark(s.sid)}.`).join(" ") + (conflicts.length ? " The documents disagree on this point." : "");
  return {
    facts_by_source: scored.map((s) => ({ source_id: s.sid, relevant_fact: s.line })),
    conflicts,
    status: "answered",
    answer: all ? answer : "",
    citations,
  };
}

function enrichment(user: string) {
  const header = (user.match(/^DOCUMENT: (.*)$/m) || [])[1] || "";
  const sub = header.split(" — ")[1]?.replace(/\s*\(.*\)$/, "") || header;
  const labelEn = sub.replace(/\s+(Document|Breakdown)$/i, "");
  const labelAr = /budget/i.test(sub) ? "الميزانية والجدول الزمني" : /team/i.test(sub) ? "الفريق والحوكمة" : "نظرة عامة على المشروع";
  const ids = [...user.matchAll(/^- (D\d+-S\d+(?:-\d+)?): (.*)$/gm)];
  return {
    doc_label_en: labelEn,
    doc_label_ar: labelAr,
    doc_summary_en: `${labelEn} of the Almamlaka TV Digital Expansion Initiative.`,
    doc_summary_ar: `${labelAr} لمبادرة التوسع الرقمي في قناة المملكة.`,
    suggested_questions_en: [`What does the ${labelEn.toLowerCase()} document say about the project?`],
    suggested_questions_ar: [`ماذا تذكر وثيقة ${labelAr}؟`],
    chunks: ids.map((m) => {
      const toks = [...new Set(enTokens(m[2]).filter((t) => !/^\d+$/.test(t)))].slice(0, 5);
      return {
        chunk_id: m[1],
        context: `From the ${labelEn} document of the Almamlaka TV Digital Expansion Initiative (DEI): ${m[2].slice(0, 80)}`,
        keywords_en: toks,
        keywords_ar: toks.map((t) => EN_AR[t]).filter(Boolean),
      };
    }),
  };
}

function conflictAudit(user: string) {
  const chunks = [...user.matchAll(/\[(D\d+-S\d+(?:-\d+)?)\] \(document: [^)]*\)\n([\s\S]*?)(?=\n\n\[D|\s*$)/g)].map((m) => ({ id: m[1], text: m[2] }));
  const find = (re: RegExp) => chunks.flatMap((c) => c.text.split("\n").filter((l) => re.test(l)).map((l) => ({ id: c.id, line: l })));
  const out = [];
  const b = find(/(Total Approved Budget|adjusted to \$2,600,000)/);
  if (b.length >= 2)
    out.push({
      topic_en: "Total project budget",
      topic_ar: "إجمالي ميزانية المشروع",
      attribute: "total budget",
      kind: "revision",
      claims: b.map((x) => ({ chunk_id: x.id, value: (x.line.match(/\$[\d,]+/) || [""])[0], quote: x.line.length > 160 ? (x.line.match(/[^.]*\$2,600,000[^.]*/) || [x.line])[0].trim() : x.line })),
      explanation_en: "The overview lists $2,400,000 while the budget notes say it was revised to $2,600,000.",
      explanation_ar: "تذكر النظرة العامة 2,400,000 دولار بينما تشير ملاحظات الميزانية إلى تعديلها إلى 2,600,000 دولار.",
    });
  const d = find(/(Planned Launch Date|moved|Public launch)/);
  if (d.length >= 2)
    out.push({
      topic_en: "Public launch date",
      topic_ar: "موعد الإطلاق العام",
      attribute: "launch date",
      kind: "revision",
      claims: d.map((x) => ({ chunk_id: x.id, value: (x.line.match(/(March 15|April 1), 2027/) || [""])[0], quote: x.line.replace(/^\|\s*|\s*\|$/g, "").length > 160 ? (x.line.match(/[^.]*April 1, 2027[^.]*/) || [x.line])[0].trim() : x.line.replace(/^\|\s*|\s*\|$/g, "") })),
      explanation_en: "Two documents give March 15, 2027 while the governance document says it moved to April 1, 2027.",
      explanation_ar: "تذكر وثيقتان 15 مارس 2027 بينما تشير وثيقة الحوكمة إلى نقله إلى 1 أبريل 2027.",
    });
  return { conflicts: out };
}

// ------------------------------------------------------------------ server

export async function startMockAI(port = 0): Promise<{ url: string; state: MockState; close: () => Promise<void> }> {
  const state: MockState = { calls: [], failRerank: false, failEmbed: false, rateLimitSchema: null, fabricateQuotes: false, modelQuirks: false };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return send(400, { error: "bad json" });
      }
      if (req.url === "/openai/v1/chat/completions") {
        const schema = body.response_format?.json_schema?.name;
        state.calls.push({ path: req.url, schema });
        if (state.rateLimitSchema && schema === state.rateLimitSchema) return send(429, { error: { message: "rate limit" } }, { "retry-after": "30" });
        const user = body.messages?.find((m: any) => m.role === "user")?.content ?? "";
        const data =
          schema === "query_analysis" ? analyze(user) : schema === "grounded_answer" ? grounded(user, state) : schema === "chunk_enrichment" ? enrichment(user) : schema === "conflict_audit" ? conflictAudit(user) : {};
        return send(200, {
          id: "mock",
          model: body.model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(data) } }],
          usage: { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 200, total_tokens: Math.ceil(raw.length / 4) + 200 },
        });
      }
      if (req.url === "/v1/embeddings") {
        state.calls.push({ path: req.url });
        if (state.failEmbed) return send(503, { detail: "unavailable" });
        const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
        const dims = body.dimensions || 1024;
        return send(200, { data: input.map((t, i) => ({ index: i, embedding: hashVec(t, dims) })), usage: { total_tokens: input.join(" ").length / 4 } });
      }
      if (req.url === "/v1/rerank") {
        state.calls.push({ path: req.url });
        if (state.failRerank) return send(503, { detail: "unavailable" });
        const q = new Set(enTokens(body.query).filter((t) => !GENERIC.has(t)));
        const results = (body.documents as string[]).map((d, i) => {
          const toks = enTokens(d);
          const hit = toks.filter((t) => q.has(t)).length;
          return { index: i, relevance_score: Number((hit / Math.sqrt(toks.length + 1)).toFixed(4)) };
        });
        results.sort((a, b) => b.relevance_score - a.relevance_score);
        return send(200, { results: results.slice(0, body.top_n ?? results.length) });
      }
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const { port: p } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${p}`, state, close: () => new Promise((r) => server.close(() => r())) };
}
