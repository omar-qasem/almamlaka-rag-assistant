// Ingestion workflow as a LangGraph graph. The API streams each node's report
// to the browser (graph.stream, streamMode "updates") so the UI animates the
// pipeline while it really runs.
//
//   clean -> structure -> chunk -> enrich -> embed -> index -> conflicts -> persist

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { config } from "../config";
import { buildBm25, rareTerms, topTerms } from "../lib/bm25";
import { jinaEmbed } from "../lib/jina";
import { kv } from "../lib/kv";
import { encodeVector, pca2d, similarityMatrix } from "../lib/vector";
import type { Bm25Index, Chunk, CleanDoc, Conflict, DocProfile, KnowledgeBase, StructuredDoc, UploadedFile } from "../types";
import { chunkDocuments } from "./chunk";
import { cleanDocuments } from "./clean";
import { mineConflicts } from "./conflicts";
import { bm25Text, enrichChunks, indexText } from "./enrich";
import { detectStructure } from "./structure";

export const INGEST_STAGES = ["clean", "structure", "chunk", "enrich", "embed", "index", "conflicts", "persist"] as const;
export type IngestStage = (typeof INGEST_STAGES)[number];

export interface StageReport {
  stage: IngestStage;
  status: "done" | "skipped" | "partial";
  ms: number;
  report: unknown;
}

const IngestState = Annotation.Root({
  kbId: Annotation<string>(),
  files: Annotation<UploadedFile[]>(),
  docs: Annotation<CleanDoc[]>(),
  structured: Annotation<StructuredDoc[]>(),
  chunks: Annotation<Chunk[]>(),
  profiles: Annotation<DocProfile[]>(),
  suggested: Annotation<{ en: string[]; ar: string[] }>(),
  vectors: Annotation<number[][]>(),
  bm25: Annotation<Bm25Index>(),
  registry: Annotation<Conflict[]>(),
  stage: Annotation<StageReport>(),
});
type S = typeof IngestState.State;

const timed =
  (stage: IngestStage, fn: (s: S) => Promise<Partial<S> & { _report: unknown; _status?: StageReport["status"] }>) =>
  async (s: S): Promise<Partial<S>> => {
    const t0 = Date.now();
    const { _report, _status, ...update } = await fn(s);
    return { ...update, stage: { stage, status: _status ?? "done", ms: Date.now() - t0, report: _report } };
  };

export function buildIngestGraph() {
  return new StateGraph(IngestState)
    .addNode(
      "clean",
      timed("clean", async (s) => {
        const { docs, report } = cleanDocuments(s.files);
        return { docs, _report: report };
      }),
    )
    .addNode(
      "structure",
      timed("structure", async (s) => {
        const { structured, report } = detectStructure(s.docs);
        return { structured, _report: report };
      }),
    )
    .addNode(
      "chunk",
      timed("chunk", async (s) => {
        const { chunks, report } = chunkDocuments(s.structured);
        if (!chunks.length) throw new Error("No text could be extracted from the uploaded files.");
        return { chunks, _report: report };
      }),
    )
    .addNode(
      "enrich",
      timed("enrich", async (s) => {
        const { chunks, profiles, suggested, report } = await enrichChunks(s.structured, s.chunks);
        return { chunks, profiles, suggested, _report: report, _status: report.status === "done" ? "done" : report.status === "partial" ? "partial" : "skipped" };
      }),
    )
    .addNode(
      "embed",
      timed("embed", async (s) => {
        const texts = s.chunks.map(indexText);
        const { vectors, tokens, ms, model, dims } = await jinaEmbed(texts, "retrieval.passage");
        const points = pca2d(vectors).map((p, i) => ({ id: s.chunks[i].id, docId: s.chunks[i].docId, ...p }));
        return {
          vectors,
          _report: {
            model,
            dims,
            tokens,
            apiMs: ms,
            task: "retrieval.passage",
            inputs: texts.length,
            sampleInput: texts[0],
            points,
            similarity: { ids: s.chunks.map((c) => c.id), matrix: similarityMatrix(vectors) },
            heads: vectors.map((v, i) => ({ id: s.chunks[i].id, head: v.slice(0, 24).map((x) => Number(x.toFixed(3))) })),
          },
        };
      }),
    )
    .addNode(
      "index",
      timed("index", async (s) => {
        const bm25 = buildBm25(s.chunks.map(bm25Text));
        return {
          bm25,
          _report: {
            vector: { count: s.vectors.length, dims: s.vectors[0]?.length ?? 0, metric: "cosine (L2-normalised dot product)" },
            bm25: { k1: bm25.k1, b: bm25.b, docs: bm25.docs.length, vocabulary: Object.keys(bm25.df).length, avgLength: Number(bm25.avgdl.toFixed(1)), topTerms: topTerms(bm25, 12), rareTerms: rareTerms(bm25, 12) },
          },
        };
      }),
    )
    .addNode(
      "conflicts",
      timed("conflicts", async (s) => {
        const { conflicts, report } = await mineConflicts(s.chunks);
        return { registry: conflicts, _report: report, _status: report.status === "done" ? "done" : "skipped" };
      }),
    )
    .addNode(
      "persist",
      timed("persist", async (s) => {
        const corpusLanguage = s.structured.filter((d) => d.language === "ar").length > s.structured.length / 2 ? "ar" : "en";
        const kb: KnowledgeBase = {
          version: 1,
          kbId: s.kbId,
          createdAt: new Date().toISOString(),
          docs: s.profiles,
          chunks: s.chunks,
          dims: s.vectors[0]?.length ?? config.jina.dims,
          vectors: s.vectors.map(encodeVector),
          embedModel: config.jina.embedModel,
          bm25: s.bm25,
          conflicts: s.registry ?? [],
          suggested: s.suggested ?? { en: [], ar: [] },
          corpusLanguage,
        };
        const json = JSON.stringify(kb);
        await kv("kb").setJSON(s.kbId, kb);
        return { _report: { kbId: s.kbId, bytes: json.length, store: "Netlify Blobs (store: almamlaka-kb)", chunks: kb.chunks.length, conflicts: kb.conflicts.length } };
      }),
    )
    .addEdge(START, "clean")
    .addEdge("clean", "structure")
    .addEdge("structure", "chunk")
    .addEdge("chunk", "enrich")
    .addEdge("enrich", "embed")
    .addEdge("embed", "index")
    .addEdge("index", "conflicts")
    .addEdge("conflicts", "persist")
    .addEdge("persist", END)
    .compile();
}
