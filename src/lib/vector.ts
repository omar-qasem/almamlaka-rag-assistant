// Vector helpers: compact storage, cosine similarity, and a 2-D PCA projection
// used by the ingestion visualisation.

export function l2normalize(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function encodeVector(v: number[]): string {
  return Buffer.from(new Float32Array(v).buffer).toString("base64");
}

export function decodeVector(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Pairwise cosine similarity for (already normalised) vectors. */
export function similarityMatrix(vs: ArrayLike<number>[]): number[][] {
  return vs.map((a) => vs.map((b) => Number(dot(a, b).toFixed(3))));
}

/** Project vectors to 2-D with PCA (power iteration on the covariance, no deps). */
export function pca2d(vs: ArrayLike<number>[]): { x: number; y: number }[] {
  const n = vs.length;
  if (n === 0) return [];
  const d = vs[0].length;
  const mean = new Float64Array(d);
  for (const v of vs) for (let j = 0; j < d; j++) mean[j] += v[j] / n;
  const X = vs.map((v) => Float64Array.from({ length: d }, (_, j) => v[j] - mean[j]));

  const component = (exclude: Float64Array | null): Float64Array => {
    let w = Float64Array.from({ length: d }, (_, j) => Math.sin(j * 12.9898 + 78.233)); // deterministic seed
    for (let it = 0; it < 60; it++) {
      // w' = X^T X w   (computed as X^T (X w) to stay O(n*d))
      const xw = X.map((row) => dot(row, w));
      const next = new Float64Array(d);
      for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) next[j] += X[i][j] * xw[i];
      if (exclude) {
        const p = dot(next, exclude);
        for (let j = 0; j < d; j++) next[j] -= p * exclude[j];
      }
      const norm = Math.hypot(...next) || 1;
      for (let j = 0; j < d; j++) next[j] /= norm;
      w = next;
    }
    return w;
  };
  const c1 = component(null);
  const c2 = component(c1);
  const pts = X.map((row) => ({ x: dot(row, c1), y: dot(row, c2) }));
  const maxAbs = Math.max(1e-9, ...pts.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));
  return pts.map((p) => ({ x: Number((p.x / maxAbs).toFixed(4)), y: Number((p.y / maxAbs).toFixed(4)) }));
}
