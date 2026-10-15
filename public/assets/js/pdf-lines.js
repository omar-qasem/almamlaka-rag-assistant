// Rebuilds reading-order lines (and table cells) from PDF.js text items.
// Shared by the browser ("Read the files" stage) and the Node test suite, so the
// tests run exactly the code the site runs.

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;

function lineDirection(items) {
  let ar = 0;
  let total = 0;
  for (const it of items) {
    ar += (it.str.match(ARABIC) || []).length;
    total += it.str.replace(/\s/g, "").length;
    if (it.dir === "rtl") ar += 2;
  }
  return total && ar / total > 0.4 ? "rtl" : "ltr";
}

function dominantFont(items) {
  const chars = new Map();
  for (const it of items) chars.set(it.font, (chars.get(it.font) || 0) + it.str.length);
  return [...chars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/**
 * @param {{items: Array<any>}} textContent result of page.getTextContent()
 * @returns {Array<{text:string, cells:string[]|null, x:number, y:number, h:number, font:string, dir:"ltr"|"rtl"}>}
 */
export function linesFromTextContent(textContent) {
  const items = [];
  for (const it of textContent.items) {
    if (typeof it.str !== "string" || !it.str.trim()) continue;
    const [, , c, d, x, y] = it.transform;
    const h = it.height || Math.hypot(c, d) || 10;
    items.push({ str: it.str, x, y, w: it.width || 0, h, font: it.fontName, dir: it.dir });
  }

  // Group items that share a baseline.
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of items) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(1.5, 0.35 * Math.min(r.h, it.h)));
    if (row) {
      row.items.push(it);
      row.h = Math.max(row.h, it.h);
    } else rows.push({ y: it.y, h: it.h, items: [it] });
  }
  rows.sort((a, b) => b.y - a.y);

  return rows.map((row) => {
    const dir = lineDirection(row.items);
    const ordered = [...row.items].sort((a, b) => (dir === "rtl" ? b.x - a.x : a.x - b.x));
    const cells = [];
    let current = "";
    let prev = null;
    for (const it of ordered) {
      if (prev) {
        const gap = dir === "rtl" ? prev.x - (it.x + it.w) : it.x - (prev.x + prev.w);
        // A gap wider than ~1.2 x font size separates table cells; small gaps are word spaces.
        if (gap > Math.max(10, 1.2 * row.h)) {
          cells.push(current.trim());
          current = "";
        } else if (gap > 0.12 * row.h && !current.endsWith(" ") && !it.str.startsWith(" ")) {
          current += " ";
        }
      }
      current += it.str;
      prev = it;
    }
    cells.push(current.trim());
    const clean = cells.filter(Boolean);
    return {
      text: clean.join(clean.length > 1 ? " | " : ""),
      cells: clean.length > 1 ? clean : null,
      x: Math.round(Math.min(...row.items.map((i) => i.x)) * 10) / 10,
      y: Math.round(row.y * 10) / 10,
      h: Math.round(row.h * 10) / 10,
      font: dominantFont(row.items),
      dir,
    };
  });
}
