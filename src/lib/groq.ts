// Minimal Groq client (OpenAI-compatible endpoint) with strict structured outputs.
// strict: true uses constrained decoding on gpt-oss models, so every response
// parses against the JSON schema — no "almost JSON" handling needed.

import { config, type Effort } from "../config";

export class UpstreamError extends Error {
  constructor(
    message: string,
    public provider: "groq" | "jina",
    public status = 0,
    public retryAfter = 0,
    public code = "upstream_error",
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StructuredRequest {
  model: string;
  messages: ChatMessage[];
  schemaName: string;
  schema: Record<string, unknown>;
  effort?: Effort;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  ms: number;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export async function groqStructured<T>(req: StructuredRequest): Promise<StructuredResult<T>> {
  if (!config.groq.apiKey) throw new UpstreamError("GROQ_API_KEY is not set", "groq", 0, 0, "missing_key");
  const url = `${config.groq.baseUrl}/openai/v1/chat/completions`;
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    response_format: {
      type: "json_schema",
      json_schema: { name: req.schemaName, strict: true, schema: req.schema },
    },
    reasoning_effort: req.effort ?? "low",
    include_reasoning: false,
    max_completion_tokens: req.maxTokens ?? 1500,
    temperature: req.temperature ?? 0.3,
  };

  const started = Date.now();
  let lastError: UpstreamError | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${config.groq.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        req.timeoutMs ?? 25_000,
      );
    } catch (e) {
      lastError = new UpstreamError(`Groq request failed: ${(e as Error).message}`, "groq", 0, 0, "network");
      if (attempt < 1) {
        await sleep(400);
        continue;
      }
      throw lastError;
    }

    if (res.status === 429) {
      const retryAfter = Math.ceil(Number(res.headers.get("retry-after")) || 0);
      lastError = new UpstreamError("Groq rate limit reached", "groq", 429, retryAfter || 10, "rate_limited");
      if (attempt === 0 && retryAfter > 0 && retryAfter <= 6) {
        await sleep(retryAfter * 1000);
        continue;
      }
      throw lastError;
    }
    if (res.status >= 500) {
      lastError = new UpstreamError(`Groq server error ${res.status}`, "groq", res.status, 0, "server_error");
      if (attempt < 1) {
        await sleep(700);
        continue;
      }
      throw lastError;
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 400);
      // Some models reject reasoning params — drop them once and retry.
      if (res.status === 400 && /reasoning|include_reasoning/i.test(text) && "reasoning_effort" in body) {
        delete body.reasoning_effort;
        delete body.include_reasoning;
        continue;
      }
      throw new UpstreamError(`Groq error ${res.status}: ${text}`, "groq", res.status, 0, res.status === 401 ? "bad_key" : "bad_request");
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: StructuredResult<T>["usage"];
      model?: string;
    };
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? "";
    try {
      return { data: JSON.parse(content) as T, model: json.model ?? req.model, ms: Date.now() - started, usage: json.usage ?? {} };
    } catch {
      lastError = new UpstreamError("Groq returned output that is not valid JSON", "groq", 200, 0, "invalid_json");
      if (choice?.finish_reason === "length" && attempt < 2) {
        body.max_completion_tokens = Math.round(Number(body.max_completion_tokens) * 1.7);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new UpstreamError("Groq request failed", "groq");
}
