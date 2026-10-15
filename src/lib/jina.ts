// Jina AI client: multilingual embeddings (task-specific adapters) + reranker.

import { config } from "../config";
import { fetchWithTimeout, UpstreamError } from "./groq";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function jinaPost<T>(path: string, body: unknown, timeoutMs = 20_000): Promise<T> {
  if (!config.jina.apiKey) throw new UpstreamError("JINA_API_KEY is not set", "jina", 0, 0, "missing_key");
  let last: UpstreamError | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${config.jina.baseUrl}${path}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${config.jina.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
    } catch (e) {
      last = new UpstreamError(`Jina request failed: ${(e as Error).message}`, "jina", 0, 0, "network");
      await sleep(400);
      continue;
    }
    if (res.ok) return (await res.json()) as T;
    const text = (await res.text()).slice(0, 300);
    const retryAfter = Math.ceil(Number(res.headers.get("retry-after")) || 0);
    last = new UpstreamError(
      `Jina error ${res.status}: ${text}`,
      "jina",
      res.status,
      retryAfter,
      res.status === 429 ? "rate_limited" : res.status === 401 ? "bad_key" : res.status >= 500 ? "server_error" : "bad_request",
    );
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await sleep(Math.min(3000, (retryAfter || 1) * 1000));
      continue;
    }
    break;
  }
  throw last ?? new UpstreamError("Jina request failed", "jina");
}

export type EmbedTask = "retrieval.passage" | "retrieval.query";

export async function jinaEmbed(texts: string[], task: EmbedTask): Promise<{ vectors: number[][]; tokens: number; ms: number; model: string; dims: number }> {
  const started = Date.now();
  const vectors: number[][] = new Array(texts.length);
  let tokens = 0;
  const batch = 64;
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    const json = await jinaPost<{ data: { index: number; embedding: number[] }[]; usage?: { total_tokens?: number } }>("/v1/embeddings", {
      model: config.jina.embedModel,
      task,
      input: slice,
      dimensions: config.jina.dims,
      normalized: true,
      embedding_type: "float",
      truncate: true,
    });
    for (const d of json.data) vectors[i + d.index] = d.embedding;
    tokens += json.usage?.total_tokens ?? 0;
  }
  if (vectors.some((v) => !Array.isArray(v))) throw new UpstreamError("Jina returned fewer embeddings than inputs", "jina", 200, 0, "bad_response");
  return { vectors, tokens, ms: Date.now() - started, model: config.jina.embedModel, dims: vectors[0]?.length ?? 0 };
}

export async function jinaRerank(query: string, documents: string[], topN: number): Promise<{ results: { index: number; score: number }[]; ms: number; model: string }> {
  const started = Date.now();
  const json = await jinaPost<{ results: { index: number; relevance_score?: number; score?: number }[] }>("/v1/rerank", {
    model: config.jina.rerankModel,
    query,
    documents,
    top_n: Math.min(topN, documents.length),
    return_documents: false,
  });
  const results = (json.results || [])
    .map((r) => ({ index: r.index, score: Number((r.relevance_score ?? r.score ?? 0).toFixed(4)) }))
    .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < documents.length);
  return { results, ms: Date.now() - started, model: config.jina.rerankModel };
}
