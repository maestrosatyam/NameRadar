import { z } from "zod";
import { QlooClient } from "@/lib/qloo/client";
import { INSIGHTS_ENTITY_TYPES } from "@/lib/qloo/types";
import { inspectCollision, resolveAudience } from "@/lib/radar/scan";
import { AudienceInputSchema } from "@/lib/radar/types";
import { clientIp, take, tooMany } from "@/lib/server/ratelimit";

const Body = z.object({
  entity: z.object({
    id: z.string().regex(/^[0-9A-F-]{36}$/i),
    name: z.string().max(200),
    type: z.enum(INSIGHTS_ENTITY_TYPES),
  }),
  audience: AudienceInputSchema,
});

/** User-triggered "what does this namesake mean to its fans?" inspection. */
export async function POST(req: Request) {
  if (!take(`inspect:${clientIp(req)}`, 12, 6)) return tooMany();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  try {
    const client = new QlooClient({ callBudget: 10 });
    const audience = await resolveAudience(client, parsed.data.audience);
    const detail = await inspectCollision(client, parsed.data.entity, audience);
    return Response.json({ detail, calls: client.calls }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("inspect failed", err);
    return Response.json({ error: "Inspection failed." }, { status: 502 });
  }
}
