// GET /api/kb/:kbId — lets the page restore a processed document set after a
// reload in the same browser session (chunks, conflicts, suggestions; no vectors).
// GET /api/health — configuration check used by the UI and the README.

import { config, missingKeys } from "../config";
import { kv } from "../lib/kv";
import type { KnowledgeBase } from "../types";
import { fail, ID_RE, json } from "./http";

export async function handleKb(kbId: string): Promise<Response> {
  if (!ID_RE.test(kbId)) return fail(400, "bad_ids", "Invalid id.");
  const kb = await kv("kb").getJSON<KnowledgeBase>(kbId);
  if (!kb) return fail(404, "kb_not_found", "Not found.");
  return json({
    ok: true,
    kb: {
      kbId: kb.kbId,
      createdAt: kb.createdAt,
      docs: kb.docs,
      conflicts: kb.conflicts,
      suggested: kb.suggested,
      chunks: kb.chunks.map((c) => ({ id: c.id, docId: c.docId, section: `${c.sectionNumber ? `${c.sectionNumber}. ` : ""}${c.sectionTitle}`, pageStart: c.pageStart, pageEnd: c.pageEnd, tokens: c.tokens })),
    },
  });
}

export function handleHealth(): Response {
  const missing = missingKeys();
  return json({
    ok: missing.length === 0,
    missing,
    models: {
      router: config.groq.routerModel,
      generator: config.groq.generatorModel,
      enrich: config.groq.enrichModel,
      conflicts: config.groq.conflictModel,
      embeddings: `${config.jina.embedModel} (${config.jina.dims}d)`,
      reranker: config.jina.rerankModel,
    },
    reasoningEffort: config.groq.reasoningEffort,
  });
}
