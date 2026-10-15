export const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

export const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ ok: false, error: { code, message, ...extra } }, status);

export const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
