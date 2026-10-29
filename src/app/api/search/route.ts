import { QlooClient } from "@/lib/qloo/client";
import { TYPE_LABEL, parseEntities } from "@/lib/radar/entities";
import { clientIp, take, tooMany } from "@/lib/server/ratelimit";

/** Autocomplete for audience "loves" chips. Thin, rate-limited, cached proxy over Qloo /search. */
export async function GET(req: Request) {
  if (!take(`search:${clientIp(req)}`, 40, 40)) return tooMany();
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2 || q.length > 80) return Response.json({ results: [] });
  try {
    const client = new QlooClient({ callBudget: 1, maxAttempts: 1, timeoutMs: 6000 });
    const body = await client.get("/search", { query: q, take: 8 });
    const results = parseEntities(body)
      .slice(0, 6)
      .map((e) => ({
        id: e.id,
        name: e.name,
        domain: TYPE_LABEL[e.type] ?? e.type,
        hint: e.disambiguation?.slice(0, 80),
      }));
    return Response.json({ results }, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch {
    return Response.json({ results: [], error: "Search unavailable" }, { status: 502 });
  }
}
