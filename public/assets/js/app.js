// Page controller: upload dialog, the processing run (stage 1 in the browser,
// stages 2-9 streamed from the LangGraph ingestion graph), the document tiles,
// and unlocking the chat once a knowledge base exists.

import * as api from "./api.js";
import { Chat, GraphView } from "./chat.js";
import { $, clear, fmtKB, h, plural } from "./dom.js";
import { icon } from "./icons.js";
import { parsePdfFiles } from "./pdf.js";
import { Pipeline } from "./pipeline.js";

const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const MIN_STAGE_MS = 650; // keep every stage on screen long enough to follow
const SESSION_KEY = "almamlaka.kbId";

const state = {
  files: [], // File objects of the current run
  urls: new Map(), // file name -> object URL, for "open page" links
  tiles: [], // document tile models
  kb: null, // { kbId, docs, suggested, conflicts, chunkCount }
  busy: false,
  health: null,
};

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scrollToId = (id) => document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });

function sessionGet() {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}
function sessionSet(value) {
  try {
    if (value) sessionStorage.setItem(SESSION_KEY, value);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable: the session simply isn't restored after a reload */
  }
}

// ------------------------------------------------------------------ widgets

const pipeline = new Pipeline($("#track"), $("#stage-panel"));
pipeline.renderIdle(() => openUpload());

const graph = new GraphView($("#graph-svg"), $("#graph-stats"), $("#graph-note"), $(".graph-panel"));
const chat = new Chat({
  box: $("#chat-box"),
  log: $("#chat-log"),
  form: $("#composer"),
  input: $("#question"),
  send: $(".composer__send"),
  newThread: $("#new-thread"),
  graph,
  getKb: () => state.kb,
  fileUrl: (name) => state.urls.get(name) ?? null,
  onKbLost: () => {
    state.kb = null;
    sessionSet(null);
    setStatus("empty");
    setHero(false);
    chat.box.dataset.locked = "true";
    chat.input.disabled = true;
  },
});

// ------------------------------------------------------------------ header status + hero

const statusEl = $("#kb-status");
function setStatus(kind, text) {
  const DEFAULT = { empty: "لا توجد ملفات", working: "جارٍ المعالجة…", error: "توقفت المعالجة", ready: "الوثائق جاهزة" };
  statusEl.dataset.state = kind;
  $(".kb-status__text", statusEl).textContent = text || DEFAULT[kind];
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ["open-upload", "hero-cta", "lock-upload"]) $(`#${id}`).disabled = busy;
}

const heroLede = $("#hero-lede");
const heroCta = $("#hero-cta");
const HERO_LEDE = heroLede.textContent;
function setHero(ready) {
  if (ready && state.kb) {
    const kb = state.kb;
    const docs = plural(kb.docs.length, "وثيقة واحدة", "وثيقتين", "وثائق", "وثيقة");
    const chunks = plural(kb.chunkCount, "مقطع واحد", "مقطعين", "مقاطع", "مقطعاً");
    const n = kb.conflicts.length;
    const conflicts = n === 0 ? "ولم يُرصد تعارض بين الوثائق" : n === 1 ? "ورُصد تعارض واحد بين الوثائق" : n === 2 ? "ورُصد تعارضان بين الوثائق" : n <= 10 ? `ورُصدت ${n} تعارضات بين الوثائق` : `ورُصد ${n} تعارضاً بين الوثائق`;
    heroLede.textContent = `تمت معالجة ${docs} إلى ${chunks}، ${conflicts}. اسأل الآن بالعربية أو الإنجليزية.`;
    heroCta.textContent = "ابدأ المحادثة";
  } else {
    heroLede.textContent = HERO_LEDE;
    heroCta.textContent = "رفع الملفات";
  }
}

function goToChat() {
  scrollToId("chat");
  setTimeout(() => chat.focus(), reduceMotion() ? 0 : 450);
}

// ------------------------------------------------------------------ document tiles

const tilesEl = $("#doc-tiles");

function pagesLabel(n) {
  return plural(n, "صفحة واحدة", "صفحتان", "صفحات", "صفحة");
}
function chunksLabel(n) {
  return plural(n, "مقطع واحد", "مقطعان", "مقاطع", "مقطعاً");
}

function renderTiles() {
  clear(tilesEl);
  if (!state.tiles.length) {
    for (const label of ["الوثيقة الأولى", "الوثيقة الثانية", "الوثيقة الثالثة"]) {
      tilesEl.append(tileEl({ empty: true, label, headline: "بانتظار الرفع" }));
    }
    tilesEl.append(tileEl({ empty: true, label: "التعارضات", headline: "هنا تظهر الأرقام والتواريخ التي تختلف بين الوثائق بعد المعالجة." }));
    return;
  }
  for (const t of state.tiles) {
    const meta = [t.pages ? pagesLabel(t.pages) : null, t.chunks ? chunksLabel(t.chunks) : null].filter(Boolean).join("، ");
    tilesEl.append(
      tileEl({
        empty: !t.img && !t.done,
        img: t.img,
        href: t.href,
        label: t.label,
        labelDir: t.labelDir,
        headline: t.headline,
        headDir: t.headDir,
        meta: meta || null,
        file: t.name,
      }),
    );
  }
  tilesEl.append(conflictTile());
}

function tileEl({ empty, img, href, label, labelDir, headline, headDir, meta, file, items, onclick, conflict }) {
  const cls = `tile ${empty ? "tile--empty" : conflict ? "tile--conflict" : "tile--doc"}`;
  const attrs = href ? { class: cls, href, target: "_blank", rel: "noopener", title: `افتح ${file || label} في نافذة جديدة` } : { class: cls };
  if (onclick) Object.assign(attrs, { href: attrs.href || "#pipeline", onclick });
  return h(
    attrs.href ? "a" : "article",
    attrs,
    img ? h("img", { class: "tile__img", src: img, alt: "" }) : null,
    h(
      "div",
      { class: "tile__body" },
      h("span", { class: "tile__label", dir: labelDir || null }, label),
      h("h3", { class: "tile__headline", dir: headDir || null }, headline),
      items?.length ? h("ul", { class: "conflict-mini" }, items) : null,
      meta || file ? h("p", { class: "tile__meta" }, file ? h("span", { class: "ltr tile__file" }, file) : null, meta ? h("span", {}, meta) : null) : null,
    ),
  );
}

function conflictTile() {
  const kbConflicts = state.kb?.conflicts ?? state.pendingConflicts;
  if (!kbConflicts) {
    return tileEl({ empty: true, label: "التعارضات", headline: state.busy ? "يُفحص التعارض بين الوثائق بعد التقسيم والتضمين." : "هنا تظهر الأرقام والتواريخ التي تختلف بين الوثائق بعد المعالجة." });
  }
  const n = kbConflicts.length;
  const headline =
    n === 0 ? "لم يُرصد تعارض بين الوثائق" : n === 1 ? "تعارض واحد مُثبت بالاقتباس" : n === 2 ? "تعارضان مُثبتان بالاقتباس" : n <= 10 ? `${n} تعارضات مُثبتة بالاقتباس` : `${n} تعارضاً مُثبتاً بالاقتباس`;
  const items = kbConflicts.slice(0, 3).map((c) =>
    h(
      "li",
      {},
      `${c.topicAr || c.topicEn}: `,
      [...new Set(c.claims.map((cl) => cl.value))]
        .map((v) => h("bdi", {}, v))
        .flatMap((el, i) => (i ? [" مقابل ", el] : [el])),
    ),
  );
  return tileEl({
    conflict: true,
    label: "التعارضات",
    headline,
    items,
    onclick: (e) => {
      e.preventDefault();
      if (pipeline.states.conflicts && pipeline.reports.conflicts) pipeline.select("conflicts");
      scrollToId("pipeline");
    },
  });
}

/** Provisional headline from stage 1: the largest-font line on page 1. */
function largestLine(file) {
  const lines = file.pages[0]?.lines ?? [];
  return lines.reduce((a, b) => (b.h > (a?.h ?? 0) ? b : a), null)?.text ?? file.name;
}

const isArabicText = (s) => /[؀-ۿ]/.test(s || "");

// ------------------------------------------------------------------ upload dialog

const dialog = $("#upload-dialog");
const fileInput = $("#file-input");
const dropzone = $("#dropzone");
const fileList = $("#file-list");
const uploadError = $("#upload-error");
const confirmBtn = $("#upload-confirm");
let pending = [];

function openUpload() {
  if (state.busy) return;
  pending = [];
  renderPending();
  uploadError.textContent = state.health && state.health.ok === false ? healthProblem(state.health) : "";
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeUpload() {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function addFiles(list) {
  const errors = [];
  for (const f of list) {
    const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
    if (!isPdf) {
      errors.push(`«${f.name}» ليس ملف PDF.`);
      continue;
    }
    if (f.size > MAX_BYTES) {
      errors.push(`«${f.name}» أكبر من 10 ميغابايت.`);
      continue;
    }
    const same = pending.find((p) => p.name === f.name);
    if (same) {
      if (same.size !== f.size) errors.push(`يوجد ملف آخر بالاسم «${f.name}». غيّر اسم أحدهما.`);
      continue;
    }
    if (pending.length >= MAX_FILES) {
      errors.push(`الحد الأقصى ${MAX_FILES} ملفات في المرة الواحدة.`);
      break;
    }
    pending.push(f);
  }
  renderPending();
  uploadError.textContent = errors.join(" ");
}

function renderPending() {
  clear(fileList);
  pending.forEach((f, i) =>
    fileList.append(
      h(
        "li",
        {},
        h("span", { html: icon("parse") }),
        h("span", { class: "name", title: f.name }, f.name),
        h("span", { class: "size" }, fmtKB(f.size)),
        h("button", {
          type: "button",
          "aria-label": `إزالة ${f.name}`,
          html: icon("close"),
          onclick: () => {
            pending.splice(i, 1);
            renderPending();
          },
        }),
      ),
    ),
  );
  confirmBtn.disabled = pending.length === 0;
}

fileInput.addEventListener("change", () => {
  addFiles([...fileInput.files]);
  fileInput.value = "";
});
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
for (const t of ["dragenter", "dragover"]) {
  dropzone.addEventListener(t, (e) => {
    e.preventDefault();
    dropzone.classList.add("is-over");
  });
}
for (const t of ["dragleave", "dragend", "drop"]) dropzone.addEventListener(t, () => dropzone.classList.remove("is-over"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  addFiles([...(e.dataTransfer?.files ?? [])]);
});
// Files dropped anywhere on the page open the dialog with them.
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  if (dropzone.contains(e.target)) return;
  if (!dialog.open) openUpload();
  if (dialog.open) addFiles([...e.dataTransfer.files]);
});

confirmBtn.addEventListener("click", () => {
  if (!pending.length) return;
  const files = pending.slice();
  closeUpload();
  run(files);
});
$("#upload-cancel").addEventListener("click", closeUpload);

for (const id of ["open-upload", "lock-upload"]) $(`#${id}`).addEventListener("click", openUpload);
heroCta.addEventListener("click", () => (state.kb ? goToChat() : openUpload()));

// ------------------------------------------------------------------ the processing run

function explain(err) {
  const code = err?.code || "";
  const retry = Math.max(Number(err?.retryAfter) || 0, 10);
  if (code === "missing_key") return "مفاتيح الخدمات غير مضبوطة على الخادم. أضف GROQ_API_KEY و JINA_API_KEY في إعدادات Netlify ثم أعد النشر.";
  if (code === "bad_key") return "مفتاح Groq أو Jina غير صالح. تحقق من المفاتيح في إعدادات Netlify ثم أعد النشر.";
  if (code === "rate_limited" || code === "http_429") return `وصلت الخدمة إلى حدّ الطلبات المسموح به مؤقتاً. أعد المحاولة بعد ${retry} ثانية.`;
  if (code === "bad_upload") return `لم يقبل الخادم الملفات: ${err.message}`;
  if (code === "network" || err instanceof TypeError) return "تعذّر الاتصال بالخادم أو بخدمة خارجية. تحقق من الاتصال ثم أعد المحاولة.";
  if (code === "http_502" || code === "http_504" || code === "timeout") return "استغرقت المعالجة وقتاً أطول من المسموح على الخادم. أعد المحاولة.";
  return `توقفت المعالجة بسبب خطأ${code ? ` (${code})` : ""}: ${err?.message || "خطأ غير معروف"}`;
}

function revokeUrls() {
  for (const url of state.urls.values()) URL.revokeObjectURL(url);
  state.urls.clear();
}

async function run(files) {
  setBusy(true);
  revokeUrls();
  state.files = files;
  for (const f of files) state.urls.set(f.name, URL.createObjectURL(f));
  state.kb = null;
  state.pendingConflicts = null;
  sessionSet(null);
  chat.lock();
  setHero(false);
  setStatus("working");
  removeBanner();

  pipeline.reset();
  pipeline.onRetry = () => run(state.files);
  pipeline.docs = files.map((f, i) => ({ docId: `D${i + 1}`, name: f.name }));
  state.tiles = files.map((f, i) => ({ docId: `D${i + 1}`, name: f.name, label: f.name, labelDir: "ltr", headline: "جارٍ القراءة…", href: state.urls.get(f.name) }));
  renderTiles();
  scrollToId("pipeline");

  // Stage 1 — read the PDFs in the browser.
  pipeline.setState("parse", "running");
  let parsed;
  const t0 = performance.now();
  try {
    const res = await parsePdfFiles(files, (p) => pipeline.setProgress("parse", `قراءة ${p.file}: الصفحة ${p.page} من ${p.pages}`));
    parsed = res.parsed;
  } catch (e) {
    return stop("parse", `تعذّرت قراءة أحد الملفات. تأكد أنه ملف PDF سليم وغير محمي بكلمة مرور. (${e?.message || e})`);
  }
  const ms = performance.now() - t0;
  await sleep(Math.max(0, MIN_STAGE_MS - ms));
  const noText = parsed.filter((f) => f.stats.chars === 0);
  if (noText.length) {
    pipeline.setReport("parse", { files: parsed });
    return stop("parse", `لا يحتوي ${noText.map((f) => `«${f.name}»`).join(" و ")} على نص قابل للتحديد (ملف ممسوح ضوئياً). أزل الملف أو استخدم نسخة نصية منه.`);
  }
  pipeline.setReport("parse", { files: parsed });
  pipeline.setState("parse", "done", ms);
  parsed.forEach((f, i) => {
    Object.assign(state.tiles[i], { img: f.thumb, pages: f.pageCount, headline: largestLine(f), headDir: "auto" });
  });
  renderTiles();

  // Stages 2-9 — the LangGraph ingestion graph, streamed node by node.
  const payload = parsed.map((f) => ({ name: f.name, size: f.size, pageCount: f.pageCount, pages: f.pages }));
  let current = "clean";
  let shownAt = performance.now();
  let finished = false;
  try {
    await api.ingest(payload, async (ev) => {
      if (ev.type === "stage-start") {
        current = ev.stage;
        shownAt = performance.now();
        pipeline.setState(ev.stage, "running");
      } else if (ev.type === "stage") {
        await sleep(Math.max(0, MIN_STAGE_MS - (performance.now() - shownAt)));
        onStageReport(ev.stage, ev.report);
        pipeline.setReport(ev.stage, ev.report);
        pipeline.setState(ev.stage, ev.status, ev.ms);
      } else if (ev.type === "done") {
        finished = true;
        onDone(ev);
      } else if (ev.type === "error") {
        finished = true;
        stop(ev.stage || current, explain(ev));
      }
    });
  } catch (e) {
    return stop(current, explain(e));
  }
  if (!finished) stop(current, "انقطع الاتصال بالخادم قبل اكتمال المعالجة. أعد المحاولة.");
}

/** Feed stage results into the document tiles as they arrive. */
function onStageReport(stage, report) {
  if (stage === "structure") {
    for (const d of report.docs) {
      const t = state.tiles.find((x) => x.docId === d.docId);
      if (t) Object.assign(t, { headline: d.subtitle || d.title, headDir: "auto" });
      const p = pipeline.docs.find((x) => x.docId === d.docId);
      if (p) Object.assign(p, { title: d.title, subtitle: d.subtitle });
    }
  } else if (stage === "chunk") {
    for (const t of state.tiles) t.chunks = report.stats.perDoc[t.docId] || 0;
  } else if (stage === "enrich") {
    for (const d of report.docs) {
      const t = state.tiles.find((x) => x.docId === d.docId);
      if (t && d.labelAr) Object.assign(t, { label: d.labelAr, labelDir: isArabicText(d.labelAr) ? "rtl" : "ltr" });
      if (t && d.summaryAr) Object.assign(t, { headline: d.summaryAr, headDir: "rtl" });
      const p = pipeline.docs.find((x) => x.docId === d.docId);
      if (p) Object.assign(p, { labelAr: d.labelAr, labelEn: d.labelEn });
    }
  } else if (stage === "conflicts") {
    state.pendingConflicts = report.conflicts ?? [];
  } else {
    return;
  }
  renderTiles();
}

function onDone(ev) {
  state.kb = { kbId: ev.kbId, docs: ev.docs, suggested: ev.suggested, conflicts: ev.conflicts, chunkCount: ev.chunkCount };
  sessionSet(ev.kbId);
  pipeline.docs = ev.docs;
  for (const t of state.tiles) t.done = true;
  renderTiles();
  setBusy(false);
  ready();
  showBanner(ev);
  pipeline.select("chunk");
}

function stop(stage, message) {
  pipeline.renderError(stage, message);
  setStatus("error");
  setBusy(false);
  state.pendingConflicts = null;
  renderTiles();
}

function ready() {
  const n = state.kb.docs.length;
  setStatus("ready", plural(n, "وثيقة واحدة جاهزة", "وثيقتان جاهزتان", "وثائق جاهزة", "وثيقة جاهزة"));
  setHero(true);
  chat.unlock();
}

function showBanner(ev) {
  removeBanner();
  const n = ev.conflicts.length;
  const secs = ev.ms < 1000 ? "أقل من ثانية" : `${(ev.ms / 1000).toFixed(1)} ثانية`;
  const found = `${plural(ev.docs.length, "وثيقة واحدة", "وثيقتان", "وثائق", "وثيقة")}، ${chunksLabel(ev.chunkCount)}، ${n ? plural(n, "تعارض واحد مُثبت", "تعارضان مُثبتان", "تعارضات مُثبتة", "تعارضاً مُثبتاً") : "ولا تعارضات"}`;
  const text = `اكتملت المعالجة في ${secs}، والنتيجة ${found}. اضغط على أي مرحلة لترى ما فعلته ببياناتك.`;
  const banner = h("div", { class: "banner", id: "pipeline-banner", role: "status" }, h("p", {}, text), h("button", { class: "btn btn--primary", type: "button", onclick: goToChat }, "ابدأ المحادثة"));
  $("#stage-panel").before(banner);
}

function removeBanner() {
  $("#pipeline-banner")?.remove();
}

// ------------------------------------------------------------------ health + restore

function healthProblem(hres) {
  return `الخادم غير مهيأ بعد: أضف ${hres.missing.join(" و ")} في إعدادات Netlify ثم أعد النشر.`;
}

async function checkHealth() {
  const el = $("#health");
  const hres = await api.health();
  state.health = hres;
  if (!hres || typeof hres.ok !== "boolean") {
    el.textContent = "تعذّر التحقق من حالة الخادم.";
  } else if (!hres.ok) {
    el.textContent = healthProblem(hres);
  } else {
    el.textContent = `يعمل على Groq (${hres.models.generator}) و Jina (${hres.models.reranker}).`;
  }
}

async function restore() {
  const id = sessionGet();
  if (!id) return;
  const kb = await api.getKb(id);
  if (!kb || state.busy || state.kb) {
    if (!kb) sessionSet(null);
    return;
  }
  const perDoc = {};
  for (const c of kb.chunks) perDoc[c.docId] = (perDoc[c.docId] || 0) + 1;
  state.kb = { kbId: kb.kbId, docs: kb.docs, suggested: kb.suggested, conflicts: kb.conflicts, chunkCount: kb.chunks.length };
  state.tiles = kb.docs.map((d) => ({
    docId: d.docId,
    name: d.name,
    label: d.labelAr || d.labelEn || d.name,
    labelDir: isArabicText(d.labelAr) ? "rtl" : "auto",
    headline: d.summaryAr || d.subtitle || d.title,
    headDir: d.summaryAr ? "rtl" : "auto",
    pages: d.pageCount,
    chunks: perDoc[d.docId] || 0,
    done: true,
  }));
  pipeline.docs = kb.docs;
  pipeline.renderRestored(kb);
  renderTiles();
  ready();
}

renderTiles();
checkHealth();
restore();
