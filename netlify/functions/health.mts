import type { Config } from "@netlify/functions";
import { handleHealth } from "../../src/api/kb";

export default async () => handleHealth();

export const config: Config = { path: "/api/health", method: ["GET"] };
