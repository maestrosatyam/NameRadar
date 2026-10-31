import { connection } from "next/server";
import { llmConfigured } from "@/lib/llm/nebius";
import { AGENT_MODEL } from "@/lib/radar/agent";

export async function GET() {
  await connection();
  return Response.json(
    {
      ok: true,
      qlooConfigured: Boolean(process.env.QLOO_API_KEY),
      qlooBaseUrl: process.env.QLOO_API_URL ?? "https://hackathon.api.qloo.com",
      llmConfigured: llmConfigured(),
      model: AGENT_MODEL,
      commit: (process.env.GIT_COMMIT ?? process.env.VERCEL_GIT_COMMIT_SHA)?.slice(0, 7) ?? null,
      time: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
