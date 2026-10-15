// The processing track and the per-stage detail panel.

import { $, clear, fmtKB, fmtMs, h } from "./dom.js";
import { icon } from "./icons.js";
import { docLegend, heatmap, histogram, scatter, vectorBars } from "./viz.js";

export const STAGES = [
  { key: "parse", name: "قراءة الملفات", engine: "PDF.js في المتصفح", why: "يقرأ PDF.js الملفات داخل متصفحك ويعيد بناء الأسطر حسب موضعها في الصفحة، ويتعرّف على الجداول من المسافات بين الخلايا. يُرسل النص المستخرج فقط، لا ملفات PDF نفسها." },
  { key: "clean", name: "التنظيف", engine: "توحيد النص", why: "توحيد ترميز الحروف (ومنها أشكال الحروف العربية المركّبة)، وحذف أرقام الصفحات والترويسات المتكررة، وتحديد حجم خط المتن لتمييز العناوين عنه." },
  { key: "structure", name: "كشف البنية", engine: "عناوين وجداول", why: "تحديد عنوان كل وثيقة وأقسامها المرقّمة وفقراتها وجداولها اعتماداً على حجم الخط والترقيم، مع رقم الصفحة لكل جزء." },
  { key: "chunk", name: "التقسيم", engine: "قسم = مقطع", why: "كل قسم مرقّم يصبح مقطعاً واحداً: هو وحدة المعنى في هذه التقارير، ويُبقي رقم الصفحة دقيقاً في الاقتباس. لا يُجزّأ القسم إلا إذا تجاوز 350 توكن، مع تداخل 50 توكن." },
  { key: "enrich", name: "الإثراء السياقي", engine: "Groq gpt-oss-20b", why: "يكتب نموذج صغير لكل مقطع جملة تحدد موقعه في الوثيقة وكلمات مفتاحية بالعربية والإنجليزية. تُستخدم في البحث فقط ولا تُعرض كمصدر للإجابة." },
  { key: "embed", name: "التضمين", engine: "Jina v5", why: "تحويل كل مقطع (مع سطر السياق) إلى متجه بنموذج Jina متعدد اللغات، فيجد السؤال العربي المقطعَ الإنجليزي المقابل له." },
  { key: "index", name: "الفهرسة", engine: "متجهات و BM25", why: "بناء فهرسين متكاملين: متجهات للبحث بالمعنى، و BM25 للبحث الحرفي عن الأسماء والأرقام والتواريخ." },
  { key: "conflicts", name: "كشف التعارضات", engine: "Groq gpt-oss-120b", why: "مراجعة الحقائق عبر الوثائق مرة واحدة عند المعالجة. لا يُسجَّل تعارض إلا إذا وُجد اقتباس كل طرف حرفياً في المقطع المنسوب إليه." },
  { key: "persist", name: "الحفظ", engine: "Netlify Blobs", why: "حفظ المقاطع والمتجهات والفهرس وسجل التعارضات في Netlify Blobs لتستخدمها المحادثة." },
];

const STATE_LABEL = { pending: "بالانتظار", running: "جارية", done: "مكتملة", partial: "مكتملة جزئياً", skipped: "تم تخطيها", error: "خطأ" };

export class Pipeline {
  constructor(trackEl, panelEl) {
    this.track = trackEl;
    this.panel = panelEl;
    this.reports = {};
    this.states = {};
    this.times = {};
    this.errors = {};
    this.selected = null;
    this.docs = [];
    this.onRetry = null;
    this.renderTrack();
    this.renderIdle();
  }

  renderTrack() {
    clear(this.track);
    STAGES.forEach((s, i) => {
      const li = h(
        "li",
        { class: "step", "data-stage": s.key, "data-state": "pending" },
        h(
          "button",
          { class: "step__btn", type: "button", "aria-label": `${i + 1}. ${s.name}`, onclick: () => this.select(s.key) },
          h("span", { class: "step__dot", html: icon(s.key) }),
          h("span", {}, h("span", { class: "step__name" }, s.name), h("span", { class: "step__engine" }, " ", s.engine), h("span", { class: "step__time", "data-time": "" })),
        ),
      );
      this.track.append(li);
    });
  }

  reset() {
    this.reports = {};
    this.states = {};
    this.times = {};
    this.errors = {};
    this.selected = null;
    this.renderTrack();
    this.track.style.setProperty("--progress", "0");
  }

  setState(key, state, ms) {
    this.states[key] = state;
    if (ms != null) this.times[key] = ms;
    const li = this.track.querySelector(`[data-stage="${key}"]`);
    if (!li) return;
    li.dataset.state = state;
    const dot = li.querySelector(".step__dot");
    dot.innerHTML = state === "error" ? icon("alert") : icon(key);
    li.querySelector("[data-time]").textContent = ms != null ? fmtMs(ms) : state === "running" ? "…" : "";
    li.querySelector(".step__btn").setAttribute("aria-label", `${STAGES.findIndex((s) => s.key === key) + 1}. ${STAGES.find((s) => s.key === key).name}: ${STATE_LABEL[state]}`);
    const lastDone = STAGES.reduce((acc, s, i) => (["done", "partial", "skipped"].includes(this.states[s.key]) ? i : acc), -1);
    this.track.style.setProperty("--progress", String(Math.max(0, lastDone) / (STAGES.length - 1)));
    if (state === "running" || (this.selected === key && state !== "running")) this.select(key);
  }

  setReport(key, report) {
    this.reports[key] = report;
    if (this.selected === key) this.renderPanel(key);
  }

  select(key) {
    const st = this.states[key];
    if (!st || st === "pending") return;
    this.selected = key;
    for (const li of this.track.children) {
      if (li.dataset.stage === key) li.setAttribute("aria-current", "true");
      else li.removeAttribute("aria-current");
    }
    this.renderPanel(key);
  }

  /** Live progress text for the running stage (e.g. "page 2 of 3"). */
  setProgress(key, text) {
    if (this.selected !== key || this.states[key] !== "running") return;
    const t = this.panel.querySelector(".thinking__text");
    if (t) t.textContent = text;
  }

  renderIdle(onUpload) {
    clear(this.panel);
    this.panel.append(
      h("p", { class: "empty-note" }, "لم تُرفع ملفات بعد. ارفع وثائق المشروع واضغط «موافق» لتشغيل المراحل التسع على بياناتك.", onUpload ? h("button", { class: "btn btn--outline", type: "button", onclick: onUpload }, "رفع الملفات") : null),
    );
  }

  renderRestored(kb) {
    clear(this.panel);
    STAGES.forEach((s) => this.setState(s.key, "done"));
    this.selected = null;
    for (const li of this.track.children) li.removeAttribute("aria-current");
    this.panel.append(
      h("p", { class: "empty-note" }, `تمت معالجة ${kb.docs.length} وثائق في هذه الجلسة (${kb.chunks.length} مقطعاً). لعرض نتائج كل مرحلة خطوة بخطوة، ارفع الملفات مرة أخرى.`),
    );
  }

  renderError(stageKey, message) {
    this.errors[stageKey] = message;
    this.setState(stageKey, "error");
    this.select(stageKey);
  }

  renderPanel(key) {
    const stage = STAGES.find((s) => s.key === key);
    const state = this.states[key];
    const r = this.reports[key];
    clear(this.panel);
    this.panel.append(
      h(
        "div",
        { class: "stage-panel__head" },
        h("h3", { class: "stage-panel__title" }, stage.name),
        h("span", { class: `chip ${state === "done" || state === "partial" ? "chip--brand" : state === "running" || state === "error" ? "chip--tint" : ""}` }, STATE_LABEL[state] || ""),
        this.times[key] != null ? h("span", { class: "muted ltr" }, fmtMs(this.times[key])) : null,
      ),
      h("p", { class: "stage-panel__why" }, stage.why),
    );
    if (state === "running") {
      this.panel.append(h("p", { class: "thinking" }, h("span", { class: "thinking__dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")), h("span", { class: "thinking__text" }, "تعمل الآن على بياناتك…")));
      return;
    }
    if (state === "error") {
      this.panel.append(
        h(
          "div",
          { class: "error-box" },
          h("p", { style: { margin: 0 } }, this.errors[key] || "توقفت المعالجة في هذه المرحلة."),
          this.onRetry ? h("button", { class: "btn btn--outline", type: "button", onclick: () => this.onRetry() }, "إعادة المحاولة") : null,
        ),
      );
      return;
    }
    if (!r) {
      this.panel.append(h("p", { class: "empty-note" }, "تفاصيل هذه المرحلة تُعرض أثناء المعالجة في الصفحة نفسها. ارفع الملفات مرة أخرى لتراها خطوة بخطوة."));
      return;
    }
    const body = RENDER[key]?.(r, this) ?? h("pre", { class: "codeblock" }, JSON.stringify(r, null, 2));
    this.panel.append(body);
  }

  docLabel(docId) {
    const d = this.docs.find((x) => x.docId === docId);
    return d ? d.labelAr || d.labelEn || d.subtitle || d.name : docId;
  }
}

// ------------------------------------------------------------------ renderers

const kv = (pairs) => h("dl", { class: "kv" }, pairs.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));

const RENDER = {
  parse(r) {
    const wrap = h("div", {});
    wrap.append(
      h(
        "div",
        { class: "grid-auto" },
        r.files.map((f) =>
          h(
            "div",
            { class: "card file-card" },
            f.thumb ? h("img", { src: f.thumb, alt: `الصفحة الأولى من ${f.name}`, loading: "lazy" }) : h("div"),
            h("div", {}, h("p", { class: "card__title ltr" }, f.name), kv([["الصفحات", f.pageCount], ["الأسطر", f.stats.lines], ["الأحرف", f.stats.chars.toLocaleString("en-US")], ["صفوف جداول", f.stats.tableRows], ["الحجم", h("bdi", { dir: "ltr" }, fmtKB(f.size))]])),
          ),
        ),
      ),
    );
    const first = r.files[0];
    if (first) {
      const sample = first.pages.flatMap((p) => p.lines.map((l) => ({ ...l, page: p.page }))).slice(0, 14);
      wrap.append(
        h("h4", { class: "doc-title", style: { marginTop: "18px" } }, `عيّنة من الأسطر المستخرجة: ${first.name}`),
        h(
          "ul",
          { class: "lines" },
          sample.map((l) =>
            h("li", {}, h("span", { class: "mono" }, `ص${l.page}`), h("span", { class: "mono" }, `${l.h}pt`), l.cells ? h("span", { class: "chip chip--ghost" }, "صف جدول") : null, h("span", { class: "ltr", dir: "auto" }, l.text)),
          ),
        ),
      );
    }
    return wrap;
  },

  clean(r) {
    return h(
      "div",
      { class: "grid-auto" },
      r.docs.map((d) =>
        h(
          "div",
          { class: "card" },
          h("p", { class: "card__title ltr" }, d.name),
          kv([
            ["أسطر قبل التنظيف", d.linesIn],
            ["أسطر بعد التنظيف", d.linesOut],
            ["أسطر وُحّد ترميزها", d.unicodeFixed],
            ["أرقام صفحات حُذفت", d.removedPageNumbers],
            ["ترويسات مكررة حُذفت", d.removedRepeated.length],
            ["حجم خط المتن", `${d.bodyFontSize}pt`],
          ]),
          d.removedRepeated.length ? h("p", { class: "muted ltr" }, d.removedRepeated.join(" / ")) : null,
        ),
      ),
    );
  },

  structure(r, p) {
    return h(
      "div",
      { class: "grid-auto" },
      r.docs.map((d) =>
        h(
          "div",
          { class: "card" },
          h("p", { class: "card__title ltr" }, d.subtitle || d.title),
          h("p", { class: "doc-title ltr" }, `${d.title} (${d.name})`),
          h(
            "ol",
            { class: "outline ltr" },
            d.sections.map((s) =>
              h(
                "li",
                {},
                h("span", { class: "sec" }, `${s.number ? `${s.number}. ` : ""}${s.title}`, s.tables ? h("span", { class: "chip chip--ghost" }, `table, ${s.tableRows} rows`) : null),
                h("span", { class: "muted" }, `p.${s.pageStart}${s.pageEnd !== s.pageStart ? `–${s.pageEnd}` : ""}`),
              ),
            ),
          ),
        ),
      ),
    );
  },

  chunk(r, p) {
    const wrap = h("div", {});
    const maxTok = Math.max(...r.chunks.map((c) => c.tokens), 1);
    let filter = "all";
    const list = h("div", { class: "chunks" });
    const draw = () => {
      clear(list);
      for (const c of r.chunks.filter((c) => filter === "all" || c.docId === filter)) {
        list.append(
          h(
            "details",
            { class: "chunk" },
            h(
              "summary",
              {},
              h("div", { class: "chunk__top" }, h("span", { class: "chunk__id ltr" }, h("i", { class: `doc-mark doc-mark--${c.docId}`, "aria-hidden": "true" }), " ", c.id), h("span", { class: "chip chip--ghost" }, `${c.tokens} توكن`)),
              h("span", { class: "chunk__sec ltr" }, `${c.section} · p.${c.pageStart}${c.pageEnd !== c.pageStart ? `–${c.pageEnd}` : ""}${c.type !== "text" ? ` · ${c.type === "table" ? "table" : "text + table"}` : ""}`.replaceAll(" · ", "  |  ")),
              h("div", { class: "bar", "aria-hidden": "true" }, h("span", { style: { width: `${(c.tokens / maxTok) * 100}%` } })),
            ),
            h("pre", {}, c.preview),
          ),
        );
      }
    };
    const docIds = [...new Set(r.chunks.map((c) => c.docId))];
    const filters = h("div", { class: "filters", role: "group", "aria-label": "تصفية حسب الوثيقة" });
    const mk = (id, label) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(filter === id),
          onclick: (e) => {
            filter = id;
            for (const b of filters.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
            draw();
          },
        },
        h("span", { class: "chip" }, label),
      );
    filters.append(mk("all", `الكل (${r.chunks.length})`), ...docIds.map((id) => mk(id, `${p.docLabel(id)} (${r.stats.perDoc[id]})`)));
    wrap.append(
      h(
        "div",
        { class: "viz-row" },
        h(
          "div",
          {},
          kv([
            ["الطريقة", "قسم مرقّم واحد = مقطع واحد"],
            ["الحد الأعلى", `${r.strategy.maxTokens} توكن (تداخل ${r.strategy.overlapTokens} عند التجزئة)`],
            ["عدد المقاطع", r.stats.count],
            ["الحجم: أدنى / متوسط / أعلى", `${r.stats.min} / ${r.stats.avg} / ${r.stats.max} توكن`],
            ["أقسام جُزّئت / دُمجت", `${r.stats.split} / ${r.stats.merged}`],
          ]),
        ),
        h("div", {}, histogram(r.histogram), h("p", { class: "viz-caption" }, "توزيع أحجام المقاطع (توكن)")),
      ),
      h("div", { style: { height: "18px" } }),
      filters,
      list,
    );
    draw();
    return wrap;
  },

  enrich(r, p) {
    const wrap = h("div", {});
    if (r.status !== "done") {
      wrap.append(h("div", { class: "error-box", style: { marginBottom: "14px" } }, r.status === "skipped" ? "تعذّر الاتصال بالنموذج، فاستُخدمت عناوين الأقسام كسياق بديل وتابعت المعالجة." : "اكتمل الإثراء لبعض الوثائق فقط؛ البقية استخدمت عناوين الأقسام.", r.reason ? h("div", { class: "ltr muted" }, r.reason) : null));
    }
    wrap.append(
      kv([["النموذج", r.model], ["التوكنات", Math.round(r.tokens || 0).toLocaleString("en-US")], ["الزمن", h("bdi", { dir: "ltr" }, fmtMs(r.ms))]]),
      h("div", { style: { height: "14px" } }),
      h(
        "div",
        { class: "grid-auto" },
        r.docs.map((d) => h("div", { class: "card" }, h("p", { class: "card__title" }, d.labelAr), h("p", { class: "doc-title ltr" }, d.labelEn), d.summaryAr ? h("p", { style: { margin: 0, fontSize: "var(--fs-ui)" } }, d.summaryAr) : null)),
      ),
      h("h4", { class: "doc-title", style: { marginTop: "18px" } }, "سطر السياق والكلمات المفتاحية لكل مقطع"),
      h(
        "div",
        { class: "ctx-list" },
        r.chunks.map((c) =>
          h(
            "div",
            { class: "ctx" },
            h("strong", { class: "ltr" }, c.id),
            c.source === "fallback" ? h("span", { class: "chip chip--ghost", style: { marginInlineStart: "8px" } }, "بديل") : null,
            h("p", { class: "ltr" }, c.context),
            c.keywordsEn.length || c.keywordsAr.length ? h("div", { class: "kw" }, [...c.keywordsEn.map((k) => h("span", { class: "chip ltr" }, k)), ...c.keywordsAr.map((k) => h("span", { class: "chip chip--tint" }, k))]) : null,
          ),
        ),
      ),
    );
    return wrap;
  },

  embed(r, p) {
    const docs = [...new Set(r.points.map((x) => x.docId))].map((id) => ({ docId: id, label: p.docLabel(id) }));
    const detail = h("div", {});
    const showVector = (id) => {
      clear(detail);
      const head = r.heads.find((x) => x.id === id);
      if (!head) return;
      detail.append(h("p", { class: "viz-caption" }, `أول ${head.head.length} قيمة من متجه `, h("strong", { class: "ltr" }, id), ` (من ${r.dims})`), vectorBars(head.head));
    };
    const wrap = h(
      "div",
      {},
      kv([["النموذج", r.model], ["مهمة المقاطع", h("span", { class: "ltr" }, r.task)], ["مهمة الأسئلة", h("span", { class: "ltr" }, "retrieval.query")], ["الأبعاد", r.dims], ["المدخلات", r.inputs], ["التوكنات", Math.round(r.tokens || 0).toLocaleString("en-US")], ["زمن الاستدعاء", h("span", { class: "ltr" }, fmtMs(r.apiMs))]]),
      h("div", { style: { height: "16px" } }),
      h(
        "div",
        { class: "viz-row" },
        h("div", {}, scatter(r.points, { onHover: (pt) => showVector(pt.id) }), docLegend(docs), h("p", { class: "viz-caption" }, "إسقاط PCA ثنائي الأبعاد للمتجهات: المقاطع المتقاربة في المعنى تتجاور. مرّر المؤشر على نقطة لترى متجهها."), detail),
        h("div", {}, heatmap(r.similarity.ids, r.similarity.matrix), h("p", { class: "viz-caption" }, "تشابه جيب التمام بين كل مقطعين؛ الأحمر الأغمق أكثر تشابهاً.")),
      ),
      h("details", { class: "trace", style: { marginTop: "14px" } }, h("summary", {}, "النص الذي أُرسل للتضمين (أول مقطع)"), h("pre", { class: "codeblock", style: { marginTop: "8px" } }, r.sampleInput)),
    );
    showVector(r.points[0]?.id);
    return wrap;
  },

  index(r) {
    return h(
      "div",
      { class: "grid-auto" },
      h("div", { class: "card" }, h("p", { class: "card__title" }, "فهرس المتجهات"), kv([["عدد المتجهات", r.vector.count], ["الأبعاد", r.vector.dims], ["المقياس", "جيب التمام"]])),
      h(
        "div",
        { class: "card" },
        h("p", { class: "card__title" }, "فهرس BM25"),
        kv([["k1 / b", `${r.bm25.k1} / ${r.bm25.b}`], ["المقاطع", r.bm25.docs], ["حجم المفردات", r.bm25.vocabulary], ["متوسط الطول", `${r.bm25.avgLength} مصطلح`]]),
        h("h4", { class: "doc-title", style: { marginTop: "12px" } }, "مصطلحات شائعة: تظهر في مقاطع كثيرة فوزنها منخفض"),
        h("div", { class: "terms" }, r.bm25.topTerms.map((t) => h("span", { class: "chip", dir: "auto", title: `df=${t.df}, idf=${t.idf}` }, `${t.term} ×${t.df}`))),
        r.bm25.rareTerms?.length
          ? [
              h("h4", { class: "doc-title", style: { marginTop: "12px" } }, "مصطلحات نادرة: أرقام وأسماء في مقطع أو اثنين فوزنها مرتفع"),
              h("div", { class: "terms" }, r.bm25.rareTerms.map((t) => h("span", { class: "chip chip--tint", dir: "auto", title: `df=${t.df}, idf=${t.idf}` }, `${t.term} ×${t.df}`))),
            ]
          : null,
      ),
    );
  },

  conflicts(r, p) {
    const wrap = h("div", {});
    if (r.status === "skipped") {
      wrap.append(h("div", { class: "error-box" }, "تم تخطي فحص التعارضات عند المعالجة. سيظل المساعد يقارن المصادر عند كل سؤال.", r.reason ? h("div", { class: "ltr muted" }, r.reason) : null));
      return wrap;
    }
    wrap.append(kv([["النموذج", r.model], ["مقاطع فُحصت", r.inputChunks], ["تعارضات مقترحة", r.proposed], ["مُثبتة بالاقتباس", r.conflicts.length], ["مرفوضة", r.rejected.length]]), h("div", { style: { height: "14px" } }));
    if (!r.conflicts.length) {
      wrap.append(h("p", { class: "empty-note" }, "لم يُرصد تعارض قابل للإثبات بين الوثائق."));
      return wrap;
    }
    const KIND = { revision: "تعديل لاحق", value_mismatch: "قيم مختلفة", logical_inconsistency: "تناقض منطقي" };
    wrap.append(
      h(
        "div",
        { class: "grid-auto", style: { gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 380px), 1fr))" } },
        r.conflicts.map((c) =>
          h(
            "article",
            { class: "conflict-card" },
            h("div", { class: "conflict-card__head" }, h("h4", {}, c.topicAr || c.topicEn), h("span", { class: "chip chip--ghost" }, KIND[c.kind] || c.kind), h("span", { class: "chip chip--ghost" }, c.crossDocument ? "بين وثيقتين أو أكثر" : "داخل الوثيقة نفسها")),
            h(
              "div",
              { class: "conflict-card__body" },
              h("p", { style: { margin: 0, fontSize: "var(--fs-ui)" } }, c.explanationAr || c.explanationEn),
              c.claims.map((cl) => h("div", { class: "claim" }, h("span", { class: "claim__value ltr" }, cl.value), h("span", { class: "muted" }, `${p.docLabel(cl.docId)}، ص${cl.page}`), h("blockquote", { class: "ltr" }, `“${cl.quote}”`))),
            ),
          ),
        ),
      ),
    );
    return wrap;
  },

  persist(r) {
    return kv([["معرّف قاعدة المعرفة", h("span", { class: "ltr" }, r.kbId)], ["الحجم", h("bdi", { dir: "ltr" }, fmtKB(r.bytes))], ["المكان", r.store], ["المقاطع", r.chunks], ["التعارضات", r.conflicts]]);
  },
};
