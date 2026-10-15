import type { Config } from "@netlify/functions";
import { handleChat } from "../../src/api/chat";

export default async (req: Request) => handleChat(req);

export const config: Config = {
  path: "/api/chat",
  method: ["POST"],
  // Protects the Groq / Jina quotas behind the public demo link: 20 questions / minute / IP.
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
