import type { QlooClient } from "../qloo/client";
import type { QueryParams } from "../qloo/types";
import { DOMAIN_WEIGHT, parseAffinities, parseEntities, resultsArray } from "./entities";
import { matchName, normalize, squash } from "./match";
import type {
  AudienceInput,
  CollisionDetail,
  DemographicSkew,
  NameScan,
  Namesake,
  ResolvedAudience,
  ResolvedEntity,
  ScoredNamesake,
  Verdict,
} from "./types";

export const HEAT_RED = 0.5;
export const HEAT_AMBER = 0.25;

export function bandFor(heat: number): Verdict {
  return heat >= HEAT_RED ? "red" : heat >= HEAT_AMBER ? "amber" : "green";
}

/** Small promise pool so one agent run never floods Qloo. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* ------------------------------------------------------------------ */
/* Audience                                                            */
/* ------------------------------------------------------------------ */

function pickBest(query: string, candidates: ResolvedEntity[]): ResolvedEntity | undefined {
  const q = normalize(query);
  const exact = candidates.filter((c) => normalize(c.name) === q);
  const pool = exact.length ? exact : candidates;
  return [...pool].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0];
}

export async function resolveAudience(client: QlooClient, input: AudienceInput): Promise<ResolvedAudience> {
  const resolved = await pool(input.anchors, 4, async (anchor) => {
    try {
      const body = await client.get("/search", { query: anchor, take: 8 });
      return { anchor, entity: pickBest(anchor, parseEntities(body)) };
    } catch {
      return { anchor, entity: undefined };
    }
  });
  const anchors: ResolvedEntity[] = [];
  const seen = new Set<string>();
  for (const r of resolved) {
    if (r.entity && !seen.has(r.entity.id)) {
      anchors.push(r.entity);
      seen.add(r.entity.id);
    }
  }
  return {
    label: input.label,
    anchors,
    unresolved: resolved.filter((r) => !r.entity).map((r) => r.anchor),
    ageBuckets: input.ageBuckets,
    region: input.region,
  };
}

function audienceSignals(audience: ResolvedAudience): QueryParams {
  return {
    "signal.interests.entities": audience.anchors.map((a) => a.id),
    "signal.demographics.age": audience.ageBuckets?.length ? audience.ageBuckets.join(",") : undefined,
    "signal.location.query": audience.region,
  };
}

/* ------------------------------------------------------------------ */
/* Namesakes                                                           */
/* ------------------------------------------------------------------ */

export function spellingVariants(name: string): string[] {
  const n = name.trim();
  const out = new Set<string>([n]);
  const sq = squash(n);
  if (n.includes(" ") && sq.length >= 4) out.add(sq);
  const noArticle = n.replace(/^(the|a|an)\s+/i, "");
  if (noArticle !== n) out.add(noArticle);
  return [...out].slice(0, 3);
}

export async function findNamesakes(
  client: QlooClient,
  name: string,
  extraVariants: string[] = [],
): Promise<{ namesakes: Namesake[]; variants: string[] }> {
  const variants = [...new Set([...spellingVariants(name), ...extraVariants.map((v) => v.trim()).filter(Boolean)])].slice(0, 4);
  const bodies = await pool(variants, 3, (q) =>
    client.get("/search", { query: q, take: 30 }).catch(() => undefined),
  );
  const byId = new Map<string, Namesake>();
  for (const body of bodies) {
    if (!body) continue;
    for (const e of parseEntities(body)) {
      const m = matchName(name, e.name);
      if (!m) continue;
      const prev = byId.get(e.id);
      if (!prev || prev.similarity < m.similarity) byId.set(e.id, { ...e, matchKind: m.kind, similarity: m.similarity });
    }
  }
  return { namesakes: [...byId.values()], variants };
}

/* ------------------------------------------------------------------ */
/* Audience-conditional scoring                                        */
/* ------------------------------------------------------------------ */

export function heatOf(n: { similarity: number; type: string; popularity?: number }, affinity: number | null): number {
  const domain = DOMAIN_WEIGHT[n.type] ?? 0.5;
  const pop = Math.max(0, Math.min(1, n.popularity ?? 0));
  const aff = affinity === null ? 0 : Math.max(0, Math.min(1, affinity));
  // Audience affinity dominates; general popularity is a smaller term so a
  // globally famous namesake the audience doesn't care about cools down.
  const prominence = 0.7 * aff + 0.3 * pop;
  return Number((n.similarity * domain * prominence).toFixed(4));
}

export async function scoreForAudience(
  client: QlooClient,
  namesakes: Namesake[],
  audience: ResolvedAudience,
): Promise<ScoredNamesake[]> {
  const byType = new Map<string, Namesake[]>();
  for (const n of namesakes) {
    const list = byType.get(n.type) ?? [];
    list.push(n);
    byType.set(n.type, list);
  }
  const affinity = new Map<string, number>();
  await pool([...byType.entries()], 4, async ([type, list]) => {
    const ids = list
      .sort((a, b) => b.similarity - a.similarity || (b.popularity ?? 0) - (a.popularity ?? 0))
      .slice(0, 25)
      .map((n) => n.id);
    const params: QueryParams = {
      "filter.type": type,
      ...audienceSignals(audience),
      "filter.results.entities": ids,
      take: ids.length,
    };
    try {
      const body = await client.get("/v2/insights", params);
      for (const [id, a] of parseAffinities(body)) affinity.set(id, a);
    } catch {
      // leave unscored; surfaced as audienceAffinity=null
    }
  });
  return namesakes
    .map((n) => {
      const a = affinity.has(n.id) ? (affinity.get(n.id) as number) : null;
      const heat = heatOf(n, a);
      return { ...n, audienceAffinity: a, proximity: DOMAIN_WEIGHT[n.type] ?? 0.5, heat, band: bandFor(heat) };
    })
    .sort((a, b) => b.heat - a.heat);
}

export function summarize(name: string, scored: ScoredNamesake[], variants: string[]): NameScan {
  const top = scored[0];
  const heat = top?.heat ?? 0;
  const notes: string[] = [];
  if (scored.length === 0) notes.push("No namesakes found in Qloo's cultural graph for this name or its spelling variants.");
  const unscored = scored.filter((s) => s.audienceAffinity === null).length;
  if (unscored) notes.push(`${unscored} namesake(s) had no audience affinity score from Qloo; they are rated on popularity only.`);
  return { name, verdict: bandFor(heat), heat, namesakes: scored.slice(0, 12), searchedVariants: variants, notes };
}

export async function scanName(
  client: QlooClient,
  name: string,
  audience: ResolvedAudience,
  extraVariants: string[] = [],
): Promise<NameScan> {
  const { namesakes, variants } = await findNamesakes(client, name, extraVariants);
  const scored = await scoreForAudience(client, namesakes, audience);
  return summarize(name, scored, variants);
}

/* ------------------------------------------------------------------ */
/* Collision inspection                                                */
/* ------------------------------------------------------------------ */

function parseDemographics(body: unknown): DemographicSkew | undefined {
  const arr = resultsArray(body, "demographics");
  const first = arr[0] as { query?: { age?: Record<string, number>; gender?: Record<string, number> } } | undefined;
  if (!first?.query) return undefined;
  return { age: first.query.age ?? {}, gender: first.query.gender ?? {} };
}

export async function inspectCollision(
  client: QlooClient,
  entity: { id: string; name: string; type: string },
  audience: ResolvedAudience,
): Promise<CollisionDetail> {
  const [tagsBody, demoBody, audDemoBody] = await Promise.all([
    client.get("/v2/insights", { "filter.type": "urn:tag", "signal.interests.entities": [entity.id], take: 12 }).catch(() => undefined),
    client.get("/v2/insights", { "filter.type": "urn:demographics", "signal.interests.entities": [entity.id] }).catch(() => undefined),
    audience.anchors.length
      ? client
          .get("/v2/insights", { "filter.type": "urn:demographics", "signal.interests.entities": audience.anchors.map((a) => a.id) })
          .catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  const tags = resultsArray(tagsBody, "tags")
    .map((t) => t as { id?: string; tag_id?: string; name?: string; type?: string; subtype?: string })
    .filter((t) => (t.id ?? t.tag_id) && t.name)
    .map((t) => ({ id: (t.id ?? t.tag_id) as string, name: t.name as string, type: t.subtype ?? t.type }));
  return {
    entityId: entity.id,
    name: entity.name,
    type: entity.type,
    tags,
    demographics: parseDemographics(demoBody),
    audienceDemographics: parseDemographics(audDemoBody),
  };
}
