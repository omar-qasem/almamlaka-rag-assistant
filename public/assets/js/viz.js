// Small SVG charts for the processing stages (no chart library).
// Documents are told apart by shape AND tone (red circle, charcoal square,
// gray diamond), never by color alone.

import { svg } from "./dom.js";

const DOC_STYLE = {
  D1: { fill: "#9d0a0e", shape: "circle" },
  D2: { fill: "#2b2b2b", shape: "square" },
  D3: { fill: "#9a9a9a", shape: "diamond" },
};
const docStyle = (id) => DOC_STYLE[id] || { fill: "#c56e71", shape: "circle" };

function mark(docId, x, y, r = 6) {
  const s = docStyle(docId);
  if (s.shape === "square") return svg("rect", { x: x - r * 0.85, y: y - r * 0.85, width: r * 1.7, height: r * 1.7, fill: s.fill });
  if (s.shape === "diamond") return svg("rect", { x: x - r * 0.8, y: y - r * 0.8, width: r * 1.6, height: r * 1.6, fill: s.fill, transform: `rotate(45 ${x} ${y})` });
  return svg("circle", { cx: x, cy: y, r, fill: s.fill });
}

/** 2-D projection of chunk embeddings. points: [{id, docId, x, y}] in [-1, 1]. */
export function scatter(points, { width = 520, height = 340, onHover } = {}) {
  const pad = 34;
  const sx = (x) => pad + ((x + 1) / 2) * (width - 2 * pad);
  const sy = (y) => height - pad - ((y + 1) / 2) * (height - 2 * pad);
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "viz", role: "img", "aria-label": "إسقاط ثنائي الأبعاد لمتجهات المقاطع" });
  root.append(svg("rect", { x: 0.5, y: 0.5, width: width - 1, height: height - 1, fill: "#fafafa", stroke: "#e2e2e2" }));
  root.append(svg("line", { x1: sx(0), y1: pad / 2, x2: sx(0), y2: height - pad / 2, stroke: "#e6e6e6" }));
  root.append(svg("line", { x1: pad / 2, y1: sy(0), x2: width - pad / 2, y2: sy(0), stroke: "#e6e6e6" }));
  for (const p of points) {
    const g = svg("g", { tabindex: 0, style: "cursor: default" });
    g.append(mark(p.docId, sx(p.x), sy(p.y), 7));
    g.append(svg("text", { x: sx(p.x) + 10, y: sy(p.y) + 4, "font-size": 11, direction: "ltr" }, p.id));
    g.append(svg("title", {}, p.id));
    if (onHover) {
      g.addEventListener("mouseenter", () => onHover(p));
      g.addEventListener("focus", () => onHover(p));
    }
    root.append(g);
  }
  return root;
}

/** Cosine-similarity heatmap with a single-hue red scale. */
export function heatmap(ids, matrix, { size = 340 } = {}) {
  const n = ids.length;
  const label = 64;
  const cell = (size - label) / n;
  const root = svg("svg", { viewBox: `0 0 ${size} ${size}`, class: "viz", role: "img", "aria-label": "مصفوفة التشابه بين المقاطع" });
  const vals = matrix.flat().filter((_, i) => Math.floor(i / n) !== i % n);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const tone = (v) => {
    const t = hi === lo ? 1 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    // interpolate #f7e8e8 -> #9d0a0e
    const mix = (a, b) => Math.round(a + (b - a) * t);
    return `rgb(${mix(247, 157)}, ${mix(232, 10)}, ${mix(232, 14)})`;
  };
  ids.forEach((id, i) => {
    root.append(svg("text", { x: label - 6, y: label + i * cell + cell / 2 + 3.5, "font-size": Math.min(10, cell * 0.75), "text-anchor": "end", direction: "ltr" }, id));
    const t = svg("text", { x: 0, y: 0, "font-size": Math.min(10, cell * 0.75), "text-anchor": "start", direction: "ltr", transform: `translate(${label + i * cell + cell / 2 + 3.5}, ${label - 6}) rotate(-90)` }, id);
    root.append(t);
    matrix[i].forEach((v, j) => {
      const r = svg("rect", { x: label + j * cell, y: label + i * cell, width: cell - 1, height: cell - 1, fill: i === j ? "#2b2b2b" : tone(v) });
      r.append(svg("title", {}, `${ids[i]} ↔ ${ids[j]}: ${v.toFixed(2)}`));
      root.append(r);
    });
  });
  return root;
}

/** Histogram of chunk sizes. bins: [{from, to, count}] */
export function histogram(bins, { width = 360, height = 150 } = {}) {
  const max = Math.max(1, ...bins.map((b) => b.count));
  const pad = 22;
  const bw = (width - pad) / bins.length;
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "viz viz--hist", role: "img", "aria-label": "توزيع أحجام المقاطع بالتوكن" });
  bins.forEach((b, i) => {
    const hgt = (b.count / max) * (height - 40);
    const x = pad + i * bw;
    root.append(svg("rect", { x: x + 2, y: height - 22 - hgt, width: bw - 4, height: Math.max(hgt, b.count ? 2 : 0), fill: b.count ? "#9d0a0e" : "#e6e6e6" }));
    if (b.count) root.append(svg("text", { x: x + bw / 2, y: height - 26 - hgt, "font-size": 11, "text-anchor": "middle" }, String(b.count)));
    root.append(svg("text", { x: x + bw / 2, y: height - 6, "font-size": 10, "text-anchor": "middle", fill: "#777" }, String(b.from)));
  });
  root.append(svg("line", { x1: pad, y1: height - 22, x2: width, y2: height - 22, stroke: "#bbb" }));
  return root;
}

/** First N dimensions of an embedding as signed bars. */
export function vectorBars(values, { width = 360, height = 70 } = {}) {
  const max = Math.max(1e-6, ...values.map((v) => Math.abs(v)));
  const bw = width / values.length;
  const mid = height / 2;
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "viz", role: "img", "aria-label": "أول قيم المتجه" });
  root.append(svg("line", { x1: 0, y1: mid, x2: width, y2: mid, stroke: "#ddd" }));
  values.forEach((v, i) => {
    const hgt = (Math.abs(v) / max) * (mid - 4);
    root.append(svg("rect", { x: i * bw + 1, y: v >= 0 ? mid - hgt : mid, width: bw - 2, height: hgt, fill: v >= 0 ? "#9d0a0e" : "#2b2b2b" }));
  });
  return root;
}

export function docLegend(docs) {
  const wrap = document.createElement("div");
  wrap.className = "legend";
  for (const d of docs) {
    const item = document.createElement("span");
    item.innerHTML = `<i class="doc-mark doc-mark--${d.docId}" aria-hidden="true"></i>`;
    item.append(d.label);
    wrap.append(item);
  }
  return wrap;
}
