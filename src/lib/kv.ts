// Key-value persistence. Production: Netlify Blobs (zero-config inside Netlify
// Functions, strong consistency so a KB written by /api/ingest is immediately
// readable by /api/chat). Tests / local mock server: in-memory map.

import { getStore } from "@netlify/blobs";

export interface KV {
  getJSON<T>(key: string): Promise<T | null>;
  setJSON(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

const memory = new Map<string, Map<string, string>>();

function memoryStore(name: string): KV {
  if (!memory.has(name)) memory.set(name, new Map());
  const m = memory.get(name)!;
  return {
    async getJSON<T>(key: string) {
      const v = m.get(key);
      return v === undefined ? null : (JSON.parse(v) as T);
    },
    async setJSON(key, value) {
      m.set(key, JSON.stringify(value));
    },
    async delete(key) {
      m.delete(key);
    },
  };
}

// Local development without the Netlify CLI: JSON files under .data/
function fileStore(name: string): KV {
  const dir = `${process.env.KV_DIR || ".data"}/${name}`;
  const path = (key: string) => `${dir}/${encodeURIComponent(key)}.json`;
  return {
    async getJSON<T>(key: string) {
      const fs = await import("node:fs/promises");
      try {
        return JSON.parse(await fs.readFile(path(key), "utf8")) as T;
      } catch {
        return null;
      }
    },
    async setJSON(key, value) {
      const fs = await import("node:fs/promises");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path(key), JSON.stringify(value));
    },
    async delete(key) {
      const fs = await import("node:fs/promises");
      await fs.rm(path(key), { force: true });
    },
  };
}

export function kv(name: "kb" | "threads"): KV {
  if (process.env.KV_DRIVER === "memory") return memoryStore(name);
  if (process.env.KV_DRIVER === "file") return fileStore(name);
  const store = getStore({ name: `almamlaka-${name}`, consistency: "strong" });
  return {
    async getJSON<T>(key: string) {
      return ((await store.get(key, { type: "json" })) as T | null) ?? null;
    },
    async setJSON(key, value) {
      await store.setJSON(key, value);
    },
    async delete(key) {
      await store.delete(key);
    },
  };
}
