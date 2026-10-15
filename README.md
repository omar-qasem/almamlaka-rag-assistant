# Almamlaka Documents Assistant — RAG chatbot on LangGraph.js + Netlify

A bilingual (Arabic / English) chatbot that answers **only** from the PDFs you upload, cites the
document, section and page for every fact, flags conflicts between documents instead of silently
picking one, follows up across turns, and refuses prompt-injection and out-of-scope questions.

- **Live demo:** https://almamlaka-docs-assistan.netlify.app/
- **Architecture deck:** [docs/Almamlaka_RAG_Architecture.pptx](docs/Almamlaka_RAG_Architecture.pptx)
- **Stack:** LangGraph.js · Groq (`openai/gpt-oss-120b`, `openai/gpt-oss-20b`) · Jina (`jina-embeddings-v5-text-small`, `jina-reranker-v3`) · Netlify Functions + Netlify Blobs · PDF.js
- **Flow:** upload the PDFs → press **موافق** → watch the 9-stage pipeline run on your data → chat (the chat unlocks only after processing).

---

## Screenshots

Taken on the live site with the three task PDFs.

**Conflict flagged instead of picking one value.** The budget question returns both figures, each with its document, section and page.

![Budget conflict between documents](docs/screenshots/1-conflict-budget.png)

**Grounded Arabic answer with numbered citations.** Each source shows the verbatim English quote and a link that opens the PDF at that page. The panel on the left shows the LangGraph path the question took.

![Arabic answer with citations](docs/screenshots/2-answer-with-citations.png)

**Out-of-scope question and prompt injection.** Both get fixed replies in the user's language, without calling the answer model.

![Out-of-scope and prompt-injection replies](docs/screenshots/3-out-of-scope-and-injection.png)

**Live processing pipeline.** After pressing موافق, the nine stages run on the uploaded files and each one shows its real output.

![Processing pipeline](docs/screenshots/4-processing-pipeline.png)

---

## How each requirement is met

| Requirement | Implementation |
|---|---|
| Answer strictly from the PDFs | Generator sees only retrieved chunks; every answer must carry quotes that **code verifies** exist verbatim in the cited chunk (numbers must match exactly). Unverifiable answers are retried once, then replaced by a fixed "not found" reply. |
| Say clearly when information is missing | `not_found` / `off_topic` replies are fixed templates in the user's language — never generated, so they can't drift. |
| Cite document + page/section | Each chunk keeps `document`, `section` and `page`; answers carry `[S#]` markers rendered as numbered citations with the quote and an "open page" link (`file.pdf#page=N`). |
| Flag conflicts between PDFs | (1) An ingestion-time **conflict audit** (gpt-oss-120b) builds a registry of discrepancies, each claim proven by a verbatim quote. (2) Retrieval pulls in the *other side* of any known conflict. (3) The answer schema has a `conflicts` field; the UI shows a "documents disagree" box with every version and its source. |
| Multi-turn follow-ups ("What about its budget?") | Thread memory (last turns) in Netlify Blobs; a router rewrites the message into a **standalone question** before retrieval (shown in "How this answer was produced"). |
| Reply in the user's language | Script-based detection (Arabic-letter share), LLM tie-break only for mixed messages; the validator rejects an answer in the wrong language. |
| Resist prompt injection | Regex guard (EN + AR patterns) → LLM intent router → fixed refusal; sources and the question are wrapped as *data* in the prompts; the generator never sees a refusal path it could be talked out of. |
| Almamlaka TV branding | Layout mirrors almamlakatv.com (white masthead, red wordmark, gray canvas, image tiles with red-underlined labels, big red section titles), brand red `#9D0A0E`, Tajawal typeface, RTL Arabic UI. Official logo slot: see *Branding*. |
| Deployed live | Netlify (static site + 4 Functions + Blobs). See *Deploy*. |

---

## Architecture

```
Browser (public/)                                  Netlify Functions (netlify/functions → src/)
─────────────────                                  ─────────────────────────────────────────────
Stage 1  PDF.js reads PDFs, rebuilds lines/tables ──POST /api/ingest──▶ LangGraph ingestion graph (streams NDJSON per node)
         (only extracted text leaves the browser)        clean → structure → chunk → enrich → embed → index → conflicts → persist
                                                                                                                  │
                                                                                                    Netlify Blobs (KB JSON)
                                                                                                                  │
Chat UI ─────────────────────────────────────POST /api/chat───▶ LangGraph chat graph ◀── loads KB + thread memory ┘
```

### Ingestion graph (stages 2–9 run server-side, each node's output is streamed to the UI)

| # | Stage | Engine | What / why |
|---|---|---|---|
| 1 | Read files | PDF.js (browser) | Text items → lines by baseline; large x-gaps → table cells; page-1 render for the tiles. Keeps 6 MB request limits irrelevant and never uploads the PDF itself. |
| 2 | Clean | code | Unicode NFKC (fixes Arabic presentation forms), drops page numbers and repeated headers, finds the body font size. |
| 3 | Structure | code | Title, numbered sections, paragraphs and tables from font size + numbering, with page ranges. |
| 4 | Chunk | code | **One numbered section = one chunk** (see below). |
| 5 | Enrich | Groq gpt-oss-20b | Per chunk: one *context* sentence + EN/AR keywords (Anthropic's "contextual retrieval"); per document: AR/EN labels, summaries, suggested questions. Used for search only, never quoted. |
| 6 | Embed | Jina v5 small | `retrieval.passage` task, 1024-d, L2-normalised. |
| 7 | Index | code | Dense vectors + BM25 (k1 1.2, b 0.75) with Arabic normalisation and light stemming. |
| 8 | Conflicts | Groq gpt-oss-120b | Cross-document audit; each claim kept only if its quote is verbatim in its chunk and its value appears in the quote. |
| 9 | Persist | Netlify Blobs | KB JSON (chunks, vectors, BM25, conflict registry) under a random `kbId`. |

### Chat graph

```
START → guard → analyze ──greeting──────────────▶ greet ─────▶ END
                   ├──off-topic / injection────▶ refuse ────▶ END
                   └──document question──▶ retrieve → generate → validate ──ok──▶ answer ────▶ END
                                                         ▲            ├──retry (once, with the validator's feedback)
                                                         └────────────┘
                                                                      └──no evidence──▶ not_found ─▶ END
```

Two LLM calls on the happy path (router on gpt-oss-20b, answer on gpt-oss-120b); everything else is
deterministic code. The UI draws this graph and lights up the path every question takes.

---

## Key choices

**Chunking — section-level, not fixed-size.** The PDFs are short reports with numbered sections
(each 33–130 tokens; 16 chunks in total, average 62). A section is the unit of meaning *and* the unit
of citation, so one section = one chunk keeps every answer citable to an exact section and page.
Tables stay whole (rendered as Markdown) so a row is never separated from its header. Sections longer
than **350 tokens** are split on sentence boundaries with **50 tokens of overlap**; fragments under
12 tokens are merged. Fixed 512/1000-token windows would mix unrelated sections (e.g. budget + risk notes)
and blur both retrieval and citations.

**Contextual enrichment.** Each chunk is indexed with its document title, a one-line context and
bilingual keywords, so an Arabic question ("ميزانية") matches an English chunk ("budget") lexically
as well as semantically.

**Embeddings — `jina-embeddings-v5-text-small` (1024-d).** Multilingual (Arabic ↔ English in one
space), task-specific adapters for passages vs queries, cheap and fast. Queries are embedded in
both languages.

**Vector store — exact cosine search over vectors kept in Netlify Blobs.** A few hundred vectors
fit in one JSON object; brute-force search over them takes microseconds, is *exact* (no ANN recall
loss) and needs no extra service. For thousands of documents, swap `src/lib/kv.ts` + `retrieve.ts`
for pgvector / Qdrant / Pinecone — the graph doesn't change.

**Hybrid retrieval.** Dense (Jina) + BM25 → reciprocal rank fusion (k = 60) → `jina-reranker-v3`
on the top 10 → top 5, plus (a) one seat for every other document with a relevant chunk and
(b) the counterpart chunks of known conflicts (max 8 sources). BM25 catches exact amounts, dates
and names; the reranker fixes ordering; diversity keeps both sides of a disagreement visible.

**LLMs on Groq.** `gpt-oss-120b` for answers and the conflict audit (stronger reasoning, good Arabic),
`gpt-oss-20b` for routing and enrichment (fast, cheap). All calls use strict JSON-schema output.
The answer schema forces the model to list `facts_by_source` and `conflicts` *before* writing
the answer.

**Validation instead of trust.** Quotes are checked against the source text (exact, or ≥ 85 %
token-window coverage with all numbers matching). When a model translates a quote into the
answer's language or stitches two passages with "…", the quote is replaced by the verbatim sentence
of the same source that shares the claim's numbers or key words; a quote with numbers that are not
in the source is rejected outright. Citation markers in other styles (`【S1†L2】`, `[S1, S3]`, `(S1)`)
are normalised; markers without a verified quote are removed; language is checked; a failed draft is
regenerated once with the validator's feedback.

**Fallbacks.** Router down → regex guard decides; embeddings down at query time → BM25 only;
reranker down → fused order; enrichment / conflict audit down → processing continues and the UI marks
the stage as skipped; Groq rate limit → a clear "try again in N s" message.

---

## Deploy (Netlify)

The site needs a **build** (for the Functions), so use Git or the CLI — drag-and-drop deploys
publish only static files.

**Option A — from GitHub**
1. Push this folder to a GitHub repository.
2. Netlify → *Add new project* → *Import an existing project* → pick the repo. Build settings come
   from `netlify.toml` (publish `public`, functions `netlify/functions`, Node 22).
3. *Project configuration → Environment variables*: add `GROQ_API_KEY` and `JINA_API_KEY`.
4. Deploy (or *Trigger deploy* after adding the variables). Netlify Blobs needs no setup.

**Option B — Netlify CLI**
```bash
npm install
npx netlify login
npx netlify init                      # create / link the project
npx netlify env:set GROQ_API_KEY gsk_...
npx netlify env:set JINA_API_KEY jina_...
npx netlify deploy --build --prod
```

Check `https://<site>/api/health` → `"ok": true`. Then run the golden questions against the live site:
```bash
BASE_URL=https://<site>.netlify.app npm run eval
```

**Groq plan.** Groq's free plan allows about 8K tokens per minute per model. Processing three PDFs
plus a few quick questions can exceed that, and the app then shows a "rate limited, retry in N s"
message. For a smooth review, enable Groq's pay-as-you-go **Developer** plan — a question costs about
a tenth of a cent. Jina's free API key is enough.

**Abuse protection.** Netlify code-based rate limits: 6 uploads and 20 questions per minute per IP.

---

## Run locally

```bash
npm install
npm run serve:mock      # offline: Groq/Jina replaced by the test mock → http://localhost:8888
cp .env.example .env    # add your keys, then:
npm run serve           # real Groq + Jina, knowledge bases stored in .data/
npx netlify dev         # alternative: full Netlify emulation (Blobs, rate limits)
```

Tests: `npm test` (25 unit + end-to-end tests: both graphs, real handlers, mock Groq/Jina,
including a mode that imitates real-model quirks such as translated quotes),
`npm run typecheck`.

## Branding

Colors (`#9D0A0E` red, `#7A080B` red ink, `#EAEAEA` canvas) and layout follow almamlakatv.com; type is
Tajawal (self-hosted, OFL). The masthead shows the name as a text wordmark. To use the official logo,
save it as `public/assets/img/logo.svg` and uncomment the `<img class="brand__logo">` line in
`public/index.html` — the wordmark hides itself.

## Project structure

```
public/                 static site (no build step)
  index.html            RTL Arabic page
  assets/js/            app.js (upload + pipeline), chat.js (answers + graph view),
                        pipeline.js (stage panels), pdf.js + pdf-lines.js (stage 1), viz.js (SVG charts)
  vendor/pdfjs/         PDF.js 6 legacy build
netlify/functions/      ingest, chat, kb, health (thin wrappers, rate limits)
src/
  ingest/               graph.ts + one module per stage
  chat/                 graph.ts, guard, prompts, retrieve, validate, templates
  lib/                  groq, jina, bm25, vector, fuzzy (quote check), text (AR/EN), kv (Blobs)
tests/                  unit + e2e tests, mock Groq/Jina server, the three sample PDFs
scripts/                dev-server.ts, eval.ts (golden questions), extract-pdfs.mjs
docs/                   architecture deck (PowerPoint)
```

## Limitations

- Text PDFs only (scanned PDFs need OCR first). Up to 5 files, 10 MB each, 80 pages each.
- Processing must finish within Netlify's 60-second function limit — comfortable for report-sized
  documents; a large corpus would move ingestion to a background function.
- Each upload creates a new knowledge base in Netlify Blobs; there is no login, and old uploads are
  not deleted automatically.
