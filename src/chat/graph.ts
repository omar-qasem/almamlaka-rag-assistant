// The question-answering workflow as a LangGraph state graph.
//
//   START -> guard -> analyze --greeting-------------> greet ------> END
//                         |----off_topic / injection--> refuse -----> END
//                         '----document_question----> retrieve -> generate -> validate
//                                                                   ^            |
//                                                                   '---retry----+--ok--------> answer ----> END
//                                                                                '--not found-> not_found -> END
//
// Two LLM calls on the happy path (analyze on gpt-oss-20b, generate on gpt-oss-120b);
// everything else is deterministic code.

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { config } from "../config";
import { groqStructured, UpstreamError } from "../lib/groq";
import { jinaEmbed, jinaRerank } from "../lib/jina";
import type { KnowledgeBase, Lang, TraceEntry, Turn } from "../types";
import { guardInput } from "./guard";
import { ANALYZE_SCHEMA, ANSWER_SCHEMA, analyzeSystem, analyzeUser, answerSystem, answerUser, type AnalyzeOut, type AnswerOut, type PromptSource } from "./prompts";
import { retrieve, type Candidate, type RetrievalDeps } from "./retrieve";
import { errorReply, greetingReply, injectionReply, notFoundReply, offTopicReply } from "./templates";
import { validateAnswer, type SourceRef, type Validation, type VerifiedCitation, type VerifiedConflict } from "./validate";

export type Intent = AnalyzeOut["intent"];

export interface ChatResult {
  kind: "answer" | "partial" | "not_found" | "refusal" | "off_topic" | "greeting" | "error";
  language: Lang;
  text: string;
  citations: VerifiedCitation[];
  conflicts: VerifiedConflict[];
  standalone: string;
  sources: (SourceRef & { dense: number | null; bm25: number; rerank: number | null })[];
  errorCode?: string;
  retryAfter?: number;
}

const ChatState = Annotation.Root({
  message: Annotation<string>(),
  history: Annotation<Turn[]>(),
  language: Annotation<Lang>(),
  arabicShare: Annotation<number>(),
  suspicious: Annotation<string[]>(),
  intent: Annotation<Intent>(),
  standalone: Annotation<string>(),
  queryEn: Annotation<string>(),
  queryAr: Annotation<string>(),
  sources: Annotation<(SourceRef & { dense: number | null; bm25: number; rerank: number | null })[]>(),
  hints: Annotation<KnowledgeBase["conflicts"]>(),
  draft: Annotation<AnswerOut | null>(),
  validation: Annotation<Validation | null>(),
  attempts: Annotation<number>(),
  error: Annotation<{ code: string; message: string; retryAfter: number } | null>(),
  result: Annotation<ChatResult | null>(),
  trace: Annotation<TraceEntry[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});
export type ChatStateT = typeof ChatState.State;

export interface ChatDeps extends RetrievalDeps {
  llm: typeof groqStructured;
}

const defaultDeps: ChatDeps = { llm: groqStructured, embed: jinaEmbed, rerank: jinaRerank };

const toError = (e: unknown) =>
  e instanceof UpstreamError
    ? { code: e.code, message: `${e.provider}: ${e.message}`, retryAfter: e.retryAfter }
    : { code: "internal", message: (e as Error)?.message ?? String(e), retryAfter: 0 };

const sectionLabel = (c: KnowledgeBase["chunks"][number]) => `${c.sectionNumber ? `${c.sectionNumber}. ` : ""}${c.sectionTitle}`;

export function buildChatGraph(kb: KnowledgeBase, deps: ChatDeps = defaultDeps) {
  const docLabel = (docId: string) => {
    const d = kb.docs.find((x) => x.docId === docId);
    return d ? d.subtitle || d.labelEn || d.title : docId;
  };

  const guard = async (s: ChatStateT): Promise<Partial<ChatStateT>> => {
    const t0 = Date.now();
    const g = guardInput(s.message);
    return {
      message: g.message,
      language: g.language,
      arabicShare: g.arabicShare,
      suspicious: g.suspicious,
      attempts: 0,
      trace: [
        {
          node: "guard",
          ms: Date.now() - t0,
          status: "ok",
          note: `language=${g.language} (Arabic share ${g.arabicShare.toFixed(2)})${g.suspicious.length ? `; injection patterns: ${g.suspicious.join(", ")}` : ""}${g.truncated ? "; message truncated" : ""}`,
          data: { language: g.language, suspicious: g.suspicious },
        },
      ],
    };
  };

  const analyze = async (s: ChatStateT): Promise<Partial<ChatStateT>> => {
    const t0 = Date.now();
    try {
      const res = await deps.llm<AnalyzeOut>({
        model: config.groq.routerModel,
        schemaName: "query_analysis",
        schema: ANALYZE_SCHEMA as unknown as Record<string, unknown>,
        messages: [
          { role: "system", content: analyzeSystem(kb) },
          { role: "user", content: analyzeUser(s.message, s.history.slice(-config.limits.historyTurns)) },
        ],
        effort: "low",
        maxTokens: 900,
        temperature: 0.2,
      });
      const a = res.data;
      // Script-based detection wins; the model only breaks ties on genuinely
      // mixed messages (Arabic sentence full of English names, or vice versa).
      const mixed = s.arabicShare >= 0.3 && s.arabicShare <= 0.6;
      const language: Lang = mixed && (a.language === "ar" || a.language === "en") ? a.language : s.language;
      let intent: Intent = a.intent;
      // A matched injection pattern with no document question stays a refusal.
      if (s.suspicious.length && intent !== "document_question") intent = "prompt_injection";
      return {
        intent,
        language,
        standalone: a.standalone_question?.trim() || s.message,
        queryEn: a.query_en?.trim() || "",
        queryAr: a.query_ar?.trim() || "",
        trace: [
          {
            node: "analyze",
            ms: Date.now() - t0,
            status: "ok",
            note: `${res.model}: intent=${intent}${a.reason ? ` (${a.reason})` : ""}`,
            data: { intent, standalone: a.standalone_question, queryEn: a.query_en, queryAr: a.query_ar, tokens: res.usage.total_tokens },
          },
        ],
      };
    } catch (e) {
      // Router unavailable: fall back to the deterministic guard decision.
      const intent: Intent = s.suspicious.length ? "prompt_injection" : "document_question";
      const err = toError(e);
      return {
        intent,
        standalone: s.message,
        queryEn: s.language === "en" ? s.message : "",
        queryAr: s.language === "ar" ? s.message : "",
        trace: [{ node: "analyze", ms: Date.now() - t0, status: "fallback", note: `router unavailable (${err.code}); using guard decision: ${intent}` }],
      };
    }
  };

  const greet = async (s: ChatStateT): Promise<Partial<ChatStateT>> => ({
    result: { kind: "greeting", language: s.language, text: greetingReply(kb, s.language), citations: [], conflicts: [], standalone: s.standalone, sources: [] },
    trace: [{ node: "greet", ms: 0, status: "ok", note: "fixed reply" }],
  });

  const refuse = async (s: ChatStateT): Promise<Partial<ChatStateT>> => {
    const injection = s.intent === "prompt_injection";
    return {
      result: {
        kind: injection ? "refusal" : "off_topic",
        language: s.language,
        text: injection ? injectionReply(kb, s.language) : offTopicReply(kb, s.language),
        citations: [],
        conflicts: [],
        standalone: s.standalone,
        sources: [],
      },
      trace: [{ node: "refuse", ms: 0, status: "ok", note: injection ? "prompt-injection attempt: fixed refusal" : "out of scope: fixed reply" }],
    };
  };

  const retrieveNode = async (s: ChatStateT): Promise<Partial<ChatStateT>> => {
    const t0 = Date.now();
    try {
      const r = await retrieve(kb, { standalone: s.standalone, queryEn: s.queryEn, queryAr: s.queryAr }, deps);
      const sources = r.selected.map((c: Candidate, i: number) => {
        const chunk = kb.chunks[c.index];
        return {
          sid: `S${i + 1}`,
          chunkId: chunk.id,
          docId: chunk.docId,
          docLabel: docLabel(chunk.docId),
          docName: chunk.docName,
          section: sectionLabel(chunk),
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          text: chunk.text,
          reason: c.reason,
          dense: c.dense,
          bm25: c.bm25,
          rerank: c.rerank,
        };
      });
      return {
        sources,
        hints: r.hints,
        trace: [
          {
            node: "retrieve",
            ms: Date.now() - t0,
            status: r.notes.length ? "fallback" : "ok",
            note: `${r.queries.length} queries → ${r.pool.length} fused candidates → ${sources.length} sources${r.hints.length ? `; ${r.hints.length} known conflict(s) attached` : ""}${r.notes.length ? `; ${r.notes.join("; ")}` : ""}`,
            data: {
              queries: r.queries,
              pool: r.pool.map((p) => ({ chunkId: p.chunkId, dense: p.dense, bm25: p.bm25, rrf: p.rrf, rerank: p.rerank })),
              selected: sources.map((x) => ({ sid: x.sid, chunkId: x.chunkId, reason: x.reason })),
              conflictHints: r.hints.map((h) => h.id),
            },
          },
        ],
      };
    } catch (e) {
      const err = toError(e);
      return { error: err, sources: [], trace: [{ node: "retrieve", ms: Date.now() - t0, status: "error", note: err.message }] };
    }
  };

  const generate = async (s: ChatStateT): Promise<Partial<ChatStateT>> => {
    const t0 = Date.now();
    if (s.error) return {};
    const attempts = (s.attempts ?? 0) + 1;
    const feedback = s.validation && !s.validation.ok ? s.validation.blocking.map((b) => `- ${b}`).join("\n") + (s.validation.warnings.length ? `\n- also: ${s.validation.warnings.slice(0, 4).join("; ")}` : "") : undefined;
    const promptSources: PromptSource[] = s.sources.map((x) => ({
      sid: x.sid,
      docLabel: x.docLabel,
      page: x.pageStart === x.pageEnd ? String(x.pageStart) : `${x.pageStart}-${x.pageEnd}`,
      section: x.section,
      text: x.text,
    }));
    try {
      const res = await deps.llm<AnswerOut>({
        model: config.groq.generatorModel,
        schemaName: "grounded_answer",
        schema: ANSWER_SCHEMA as unknown as Record<string, unknown>,
        messages: [
          { role: "system", content: answerSystem(s.language) },
          { role: "user", content: answerUser({ question: s.standalone, original: s.message, lang: s.language, sources: promptSources, hints: s.hints ?? [], feedback }) },
        ],
        effort: config.groq.reasoningEffort,
        maxTokens: 2400,
        temperature: 0.2,
      });
      return {
        draft: res.data,
        attempts,
        trace: [
          {
            node: "generate",
            ms: Date.now() - t0,
            status: "ok",
            note: `${res.model} (attempt ${attempts}): status=${res.data.status}, ${res.data.citations.length} citation(s), ${res.data.conflicts.length} conflict(s)`,
            data: { status: res.data.status, facts: res.data.facts_by_source, tokens: res.usage.total_tokens },
          },
        ],
      };
    } catch (e) {
      const err = toError(e);
      return { error: err, attempts, trace: [{ node: "generate", ms: Date.now() - t0, status: "error", note: err.message }] };
    }
  };

  const validate = async (s: ChatStateT): Promise<Partial<ChatStateT>> => {
    const t0 = Date.now();
    if (s.error || !s.draft) return { validation: null, trace: [{ node: "validate", ms: 0, status: "skipped", note: "no draft to validate" }] };
    const v = validateAnswer(s.draft, s.sources, s.language, { related: [s.queryEn, s.standalone].filter(Boolean) });
    return {
      validation: v,
      trace: [
        {
          node: "validate",
          ms: Date.now() - t0,
          status: v.ok ? "ok" : "fallback",
          note: v.ok
            ? `passed: ${v.citations.length} verified quote(s)${v.repaired ? `, ${v.repaired} matched to the closest source sentence` : ""}${v.warnings.length - v.repaired > 0 ? `, ${v.warnings.length - v.repaired} item(s) fixed or removed` : ""}`
            : `rejected: ${v.blocking.join("; ")}`,
          data: { blocking: v.blocking, warnings: v.warnings, languageShare: v.languageShare, repaired: v.repaired },
        },
      ],
    };
  };

  const afterValidate = (s: ChatStateT) => {
    if (s.error) return "answer"; // answer node renders the error message
    if (!s.draft || s.draft.status === "not_found") return "not_found";
    if (s.validation?.ok) return "answer";
    return s.attempts < 2 ? "retry" : "not_found";
  };

  const answer = async (s: ChatStateT): Promise<Partial<ChatStateT>> => {
    if (s.error) {
      return {
        result: { kind: "error", language: s.language, text: errorReply(s.language, s.error.code, s.error.retryAfter), citations: [], conflicts: [], standalone: s.standalone, sources: s.sources ?? [], errorCode: s.error.code, retryAfter: s.error.retryAfter },
        trace: [{ node: "answer", ms: 0, status: "error", note: `returned error message (${s.error.code})` }],
      };
    }
    const v = s.validation!;
    return {
      result: {
        kind: s.draft?.status === "partial" ? "partial" : "answer",
        language: s.language,
        text: v.answer,
        citations: v.citations,
        conflicts: v.conflicts,
        standalone: s.standalone,
        sources: s.sources,
      },
      trace: [{ node: "answer", ms: 0, status: "ok", note: `${v.citations.length} citation(s), ${v.conflicts.length} conflict flag(s)` }],
    };
  };

  const notFound = async (s: ChatStateT): Promise<Partial<ChatStateT>> => ({
    result: { kind: "not_found", language: s.language, text: notFoundReply(s.language), citations: [], conflicts: [], standalone: s.standalone, sources: s.sources ?? [] },
    trace: [
      {
        node: "not_found",
        ms: 0,
        status: "ok",
        note: s.draft?.status === "not_found" ? "generator found no supporting source" : "no verifiable answer after retries",
      },
    ],
  });

  return new StateGraph(ChatState)
    .addNode("guard", guard)
    .addNode("analyze", analyze)
    .addNode("greet", greet)
    .addNode("refuse", refuse)
    .addNode("retrieve", retrieveNode)
    .addNode("generate", generate)
    .addNode("validate", validate)
    .addNode("answer", answer)
    .addNode("not_found", notFound)
    .addEdge(START, "guard")
    .addEdge("guard", "analyze")
    .addConditionalEdges("analyze", (s) => (s.intent === "greeting" ? "greet" : s.intent === "document_question" ? "retrieve" : "refuse"), {
      greet: "greet",
      refuse: "refuse",
      retrieve: "retrieve",
    })
    .addEdge("retrieve", "generate")
    .addEdge("generate", "validate")
    .addConditionalEdges("validate", afterValidate, { retry: "generate", answer: "answer", not_found: "not_found" })
    .addEdge("greet", END)
    .addEdge("refuse", END)
    .addEdge("answer", END)
    .addEdge("not_found", END)
    .compile();
}
