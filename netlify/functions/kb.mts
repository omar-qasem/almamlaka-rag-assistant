import type { Config, Context } from "@netlify/functions";
import { handleKb } from "../../src/api/kb";

export default async (_req: Request, context: Context) => handleKb(context.params.kbId ?? "");

export const config: Config = { path: "/api/kb/:kbId", method: ["GET"] };
