import { z } from "zod";
import { QlooClient } from "@/lib/qloo/client";
import { AGENT_MODEL } from "@/lib/radar/agent";
import { llmOnlyVerdict, verifyClaims, type BaselineResult } from "@/lib/radar/baseline";
import { clientIp, take, tooMany } from "@/lib/server/ratelimit";

export const maxDuration = 60;

const Body = z.object({
  name: z.string().trim().min(1).max(40),
  category: z.string().trim().min(2).max(120),
  audienceLabel: z.string().trim().min(1).max(60),
  anchors: z.array(z.string().trim().min(1).max(80)).min(1).max(4),
});

export async function POST(req: Request) {
  if (!take(`baseline:${clientIp(req)}`, 8, 4)) return tooMany();
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "LLM-only comparison is unavailable: no language model configured." }, { status: 503 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  try {
    const llm = await llmOnlyVerdict(parsed.data);
    const qloo = new QlooClient({ callBudget: 10 });
    const found = await verifyClaims(qloo, llm.namesakes);
    const result: BaselineResult = {
      model: AGENT_MODEL,
      verdict: llm.verdict,
      reasoning: llm.reasoning.slice(0, 800),
      claims: llm.namesakes.slice(0, 8).map((c, i) => ({
        name: c.name,
        domain: c.domain,
        why: c.why_this_audience_cares.slice(0, 300),
        foundInQloo: found[i] ?? false,
      })),
    };
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("baseline failed", err);
    return Response.json({ error: "LLM-only comparison failed." }, { status: 502 });
  }
}
