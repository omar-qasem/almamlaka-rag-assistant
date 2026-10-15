// Shared data shapes for ingestion, the knowledge base and the chat graph.

export type Lang = "ar" | "en";

/** A text line reconstructed from PDF.js text items (see public/assets/js/pdf-lines.js). */
export interface PdfLine {
  text: string;
  cells: string[] | null; // >= 2 cells when the line looks like a table row
  x: number;
  y: number;
  h: number; // font height in PDF points
  font: string; // PDF.js internal font id (used to spot the body font vs emphasis)
  dir: "ltr" | "rtl";
}

export interface PdfPage {
  page: number; // 1-based physical page number (what a PDF viewer shows)
  width: number;
  height: number;
  lines: PdfLine[];
}

export interface UploadedFile {
  name: string;
  size: number;
  pageCount: number;
  pages: PdfPage[];
}

export interface CleanDoc {
  docId: string; // D1, D2, ...
  name: string; // original file name
  pageCount: number;
  bodyHeight: number;
  bodyFont: string;
  pages: PdfPage[];
}

export type Block =
  | { type: "paragraph"; text: string; page: number }
  | { type: "table"; header: string[]; rows: string[][]; page: number; pageEnd: number };

export interface Section {
  key: string; // S1, S2 ... (S0 = preamble)
  number: string | null; // "3" for "3. Key Details"
  title: string;
  heading: string; // full heading line as printed
  pageStart: number;
  pageEnd: number;
  blocks: Block[];
}

export interface StructuredDoc {
  docId: string;
  name: string;
  title: string;
  subtitle: string;
  pageCount: number;
  language: Lang;
  sections: Section[];
}

export interface Chunk {
  id: string; // D2-S2 (or D2-S2-1 when a long section is split)
  docId: string;
  docName: string; // file name
  docTitle: string;
  docSubtitle: string;
  sectionKey: string;
  sectionNumber: string | null;
  sectionTitle: string;
  pageStart: number;
  pageEnd: number;
  type: "text" | "table" | "mixed";
  tokens: number;
  text: string; // display + generation text (heading included)
  // filled by the enrichment stage (or deterministic fallback)
  context: string;
  keywordsEn: string[];
  keywordsAr: string[];
}

export interface DocProfile {
  docId: string;
  name: string;
  title: string;
  subtitle: string;
  pageCount: number;
  language: Lang;
  labelEn: string;
  labelAr: string;
  summaryEn: string;
  summaryAr: string;
  sections: { number: string | null; title: string; page: number }[];
}

export interface ConflictClaim {
  chunkId: string;
  docId: string;
  value: string;
  quote: string;
  page: number;
}

export interface Conflict {
  id: string;
  topicEn: string;
  topicAr: string;
  attribute: string;
  kind: "value_mismatch" | "revision" | "logical_inconsistency";
  crossDocument: boolean;
  claims: ConflictClaim[];
  explanationEn: string;
  explanationAr: string;
}

export interface Bm25Index {
  k1: number;
  b: number;
  avgdl: number;
  df: Record<string, number>;
  docs: { len: number; tf: Record<string, number> }[];
}

export interface KnowledgeBase {
  version: 1;
  kbId: string;
  createdAt: string;
  docs: DocProfile[];
  chunks: Chunk[];
  dims: number;
  vectors: string[]; // base64 Float32 per chunk (L2-normalised)
  embedModel: string;
  bm25: Bm25Index;
  conflicts: Conflict[];
  suggested: { en: string[]; ar: string[] };
  corpusLanguage: Lang;
}

export interface Turn {
  user: string;
  standalone: string;
  assistant: string;
  language: Lang;
  kind: string;
  at: string;
}

export interface TraceEntry {
  node: string;
  ms: number;
  status: "ok" | "fallback" | "skipped" | "error";
  note: string;
  data?: unknown;
}
