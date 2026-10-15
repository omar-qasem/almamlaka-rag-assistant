import type { Config } from "@netlify/functions";
import { handleIngest } from "../../src/api/ingest";

// Streams NDJSON (one line per LangGraph node). Sync functions may run up to 60 s.
export default async (req: Request) => handleIngest(req);

export const config: Config = {
  path: "/api/ingest",
  method: ["POST"],
  // Code-based rate limit (available on all Netlify plans): 6 uploads / minute / IP.
  rateLimit: { windowLimit: 6, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
