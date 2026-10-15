// POST /api/chat — one conversation turn through the LangGraph chat graph.
// Conversation memory: serverless instances are stateless, so the last turns of
// each thread are kept in Netlify Blobs and re-hydrated into the graph state.

import { config, missingKeys } from "../config";
import { buildChatGraph, type ChatDeps, type ChatStateT } from "../chat/graph";
import { kv } from "../lib/kv";
import { truncate } from "../lib/text";
import type { KnowledgeBase, Turn } from "../types";
import { fail, ID_RE, json } from "./http";

export async function handleChat(req: Request, deps?: ChatDeps): Promise<Response> {
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");
  let body: { kbId?: string; threadId?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return fail(400, "bad_json", "Request body must be JSON.");
  }
  const { kbId = "", threadId = "", message = "" } = body;
  if (!ID_RE.test(kbId) || !ID_RE.test(threadId)) return fail(400, "bad_ids", "kbId and threadId are required.");
  if (typeof message !== "string" || !message.trim()) return fail(400, "empty_message", "Type a question first.");
  if (!deps) {
    const missing = missingKeys();
    if (missing.length) return fail(500, "missing_key", `Server is missing: ${missing.join(", ")}`);
  }

  const kb = await kv("kb").getJSON<KnowledgeBase>(kbId);
  if (!kb) return fail(404, "kb_not_found", "This document set is no longer available. Upload the files again.");

  const threads = kv("threads");
  const threadKey = `${kbId}/${threadId}`;
  const history = (await threads.getJSON<{ turns: Turn[] }>(threadKey))?.turns ?? [];

  const started = Date.now();
  const graph = buildChatGraph(kb, deps);
  const final = (await graph.invoke({ message, history: history.slice(-config.limits.historyTurns) }, { recursionLimit: 25 })) as ChatStateT;
  const result = final.result;
  if (!result) return fail(500, "no_result", "The workflow finished without an answer.");

  if (result.kind !== "error") {
    const turn: Turn = {
      user: truncate(message.trim(), 600),
      standalone: truncate(final.standalone || message, 600),
      assistant: truncate(result.text.replace(/\[S\d+\]/g, ""), 700),
      language: result.language,
      kind: result.kind,
      at: new Date().toISOString(),
    };
    await threads.setJSON(threadKey, { turns: [...history, turn].slice(-8) });
  }

  return json({
    ok: true,
    result,
    trace: final.trace,
    path: final.trace.map((t) => t.node),
    ms: Date.now() - started,
  });
}
