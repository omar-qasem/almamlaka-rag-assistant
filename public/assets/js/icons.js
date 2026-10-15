// Outline icons (24px grid, stroke = currentColor).
const P = {
  parse: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  clean: '<path d="M4 7h10M4 12h16M4 17h7"/><path d="m17 15 3 3m0-3-3 3"/>',
  structure: '<path d="M5 5h6M5 12h14M5 19h14M14 5h5"/><path d="M5 5v0"/>',
  chunk: '<rect x="3" y="4" width="8" height="7" rx="1"/><rect x="13" y="4" width="8" height="7" rx="1"/><rect x="3" y="13" width="8" height="7" rx="1"/><rect x="13" y="13" width="8" height="7" rx="1"/>',
  enrich: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><path d="m6.5 6.5 2 2m7 7 2 2m0-11-2 2m-7 7-2 2"/>',
  embed: '<circle cx="6" cy="17" r="1.8"/><circle cx="12" cy="7" r="1.8"/><circle cx="18" cy="14" r="1.8"/><path d="M7.5 15.8 10.7 8.5M13.6 8.1l3 4.6M7.8 16.6l8.4-2.2"/>',
  index: '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"/>',
  conflicts: '<path d="M12 4 3 20h18z"/><path d="M12 10v4M12 17v.5"/>',
  persist: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
};
export const icon = (name, cls = "icon") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ""}</svg>`;
