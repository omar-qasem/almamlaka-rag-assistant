// Central configuration. Values are read lazily so Netlify's runtime env vars
// (and test overrides) are always picked up.

const env = (name: string, fallback = ""): string => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
};

export type Effort = "low" | "medium" | "high";
const effort = (name: string, fallback: Effort): Effort => {
  const v = env(name, fallback);
  return v === "medium" || v === "high" || v === "low" ? v : fallback;
};

export const config = {
  groq: {
    get baseUrl() { return env("GROQ_BASE_URL", "https://api.groq.com").replace(/\/$/, ""); },
    get apiKey() { return env("GROQ_API_KEY"); },
    // Router / query analysis: tiny, fast model (~1000 tok/s on Groq).
    get routerModel() { return env("GROQ_ROUTER_MODEL", "openai/gpt-oss-20b"); },
    // Grounded answer generation: stronger reasoning for conflicts and Arabic.
    get generatorModel() { return env("GROQ_GENERATOR_MODEL", "openai/gpt-oss-120b"); },
    // Ingestion helpers.
    get enrichModel() { return env("GROQ_ENRICH_MODEL", "openai/gpt-oss-20b"); },
    get conflictModel() { return env("GROQ_CONFLICT_MODEL", "openai/gpt-oss-120b"); },
    get reasoningEffort(): Effort { return effort("GROQ_REASONING_EFFORT", "low"); },
  },
  jina: {
    get baseUrl() { return env("JINA_BASE_URL", "https://api.jina.ai").replace(/\/$/, ""); },
    get apiKey() { return env("JINA_API_KEY"); },
    get embedModel() { return env("JINA_EMBED_MODEL", "jina-embeddings-v5-text-small"); },
    get rerankModel() { return env("JINA_RERANK_MODEL", "jina-reranker-v3"); },
    get dims() { return Number(env("JINA_EMBED_DIMS", "1024")) || 1024; },
  },
  chunking: {
    // The supplied PDFs have short numbered sections (~40-150 tokens), so one
    // section = one chunk. These limits only kick in for longer sections.
    maxTokens: 350,
    overlapTokens: 50,
    minTokens: 12,
  },
  retrieval: {
    perListTop: 20, // candidates taken from each dense / BM25 list
    rrfK: 60, // reciprocal-rank-fusion constant (Cormack et al.)
    poolSize: 10, // fused candidates sent to the reranker
    finalK: 5, // best chunks always kept
    maxSources: 8, // hard cap after diversity + conflict expansion
  },
  limits: {
    maxMessageChars: 1000,
    maxFiles: 5,
    maxPagesPerFile: 80,
    maxTotalChars: 400_000,
    historyTurns: 4,
  },
};

export const missingKeys = (): string[] => {
  const missing: string[] = [];
  if (!config.groq.apiKey) missing.push("GROQ_API_KEY");
  if (!config.jina.apiKey) missing.push("JINA_API_KEY");
  return missing;
};
