// POST /api/ingest — runs the LangGraph ingestion graph and streams one NDJSON
// line per node so the browser can animate the real pipeline as it executes.

import { config, missingKeys } from "../config";
import { UpstreamError } from "../lib/groq";
import { buildIngestGraph, INGEST_STAGES, type StageReport } from "../ingest/graph";
import type { KnowledgeBase, UploadedFile } from "../types";
import { fail } from "./http";

function validateFiles(body: unknown): UploadedFile[] | string {
  const files = (body as { files?: unknown })?.files;
  if (!Array.isArray(files) || files.length === 0) return "Upload at least one PDF.";
  if (files.length > config.limits.maxFiles) return `Upload at most ${config.limits.maxFiles} files at a time.`;
  let chars = 0;
  for (const f of files as UploadedFile[]) {
    if (typeof f?.name !== "string" || !Array.isArray(f.pages)) return "Malformed upload payload.";
    if (f.pages.length > config.limits.maxPagesPerFile) return `"${f.name}" has more than ${config.limits.maxPagesPerFile} pages.`;
    for (const p of f.pages) {
      if (!Array.isArray(p?.lines)) return "Malformed page payload.";
      for (const l of p.lines) chars += typeof l?.text === "string" ? l.text.length : 0;
    }
  }
  if (chars === 0) return "No selectable text was found in these PDFs (scanned documents need OCR first).";
  if (chars > config.limits.maxTotalChars) return "The documents are too large for this demo.";
  return files as UploadedFile[];
}

export async function handleIngest(req: Request): Promise<Response> {
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");
  const missing = missingKeys();
  if (missing.length) return fail(500, "missing_key", `Server is missing: ${missing.join(", ")}`);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "bad_json", "Request body must be JSON.");
  }
  const files = validateFiles(body);
  if (typeof files === "string") return fail(400, "bad_upload", files);

  const kbId = crypto.randomUUID();
  const graph = buildIngestGraph();
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      const startedAt = Date.now();
      send({ type: "start", kbId, stages: INGEST_STAGES, files: files.map((f) => ({ name: f.name, pages: f.pages.length })) });
      let next = 0;
      let finalState: { profiles?: KnowledgeBase["docs"]; suggested?: KnowledgeBase["suggested"]; conflicts?: KnowledgeBase["conflicts"]; chunks?: KnowledgeBase["chunks"] } = {};
      try {
        send({ type: "stage-start", stage: INGEST_STAGES[0] });
        const updates = await graph.stream({ kbId, files }, { streamMode: "updates" });
        for await (const update of updates) {
          for (const [node, value] of Object.entries(update as Record<string, Record<string, unknown>>)) {
            const stage = value.stage as StageReport | undefined;
            if (value.profiles) finalState.profiles = value.profiles as KnowledgeBase["docs"];
            if (value.suggested) finalState.suggested = value.suggested as KnowledgeBase["suggested"];
            if (value.registry) finalState.conflicts = value.registry as KnowledgeBase["conflicts"];
            if (value.chunks) finalState.chunks = value.chunks as KnowledgeBase["chunks"];
            if (stage) send({ type: "stage", stage: node, status: stage.status, ms: stage.ms, report: stage.report });
            next = INGEST_STAGES.indexOf(node as (typeof INGEST_STAGES)[number]) + 1;
            if (next < INGEST_STAGES.length) send({ type: "stage-start", stage: INGEST_STAGES[next] });
          }
        }
        send({
          type: "done",
          kbId,
          ms: Date.now() - startedAt,
          docs: finalState.profiles ?? [],
          suggested: finalState.suggested ?? { en: [], ar: [] },
          conflicts: finalState.conflicts ?? [],
          chunkCount: finalState.chunks?.length ?? 0,
        });
      } catch (e) {
        const err = e as Error;
        send({
          type: "error",
          stage: INGEST_STAGES[Math.min(next, INGEST_STAGES.length - 1)],
          code: e instanceof UpstreamError ? e.code : "internal",
          message: err.message?.slice(0, 400) ?? "Unknown error",
          retryAfter: e instanceof UpstreamError ? e.retryAfter : 0,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
