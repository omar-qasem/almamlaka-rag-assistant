// Calls to the Netlify Functions.

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: { code: `http_${res.status}`, message: res.status === 429 ? "rate_limited" : text.slice(0, 200) || res.statusText } };
  }
}

/** POST /api/ingest and call onEvent for every NDJSON line as it arrives. */
export async function ingest(files, onEvent) {
  const res = await fetch("/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files }),
  });
  if (!res.ok || !res.body) {
    const body = await readJson(res);
    throw Object.assign(new Error(body?.error?.message || `HTTP ${res.status}`), { code: body?.error?.code || `http_${res.status}` });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) await onEvent(JSON.parse(line));
    }
  }
  if (buffer.trim()) await onEvent(JSON.parse(buffer));
}

export async function chat(kbId, threadId, message) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kbId, threadId, message }),
  });
  const body = await readJson(res);
  if (!res.ok || !body.ok) throw Object.assign(new Error(body?.error?.message || `HTTP ${res.status}`), { code: body?.error?.code || `http_${res.status}`, status: res.status });
  return body;
}

export async function getKb(kbId) {
  const res = await fetch(`/api/kb/${encodeURIComponent(kbId)}`);
  const body = await readJson(res);
  return res.ok && body.ok ? body.kb : null;
}

export async function health() {
  try {
    const res = await fetch("/api/health");
    return await readJson(res);
  } catch {
    return null;
  }
}
