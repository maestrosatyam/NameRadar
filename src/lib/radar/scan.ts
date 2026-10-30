import type { QlooClient } from "../qloo/client";
import type { QueryParams } from "../qloo/types";
import { calibrate, estimateRank, salienceFromRank } from "./calibrate";
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

export const HEAT_RED = 0.45;
export const HEAT_AMBER = 0.2;

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

/** Popularity is a percentile and most findable entities are above 0.8, so only the top band counts. */
export function popularityBoost(popularity?: number): number {
  return Math.max(0, Math.min(1, ((popularity ?? 0) - 0.8) / 0.2));
}

export function domainWeightFor(type: string, audience?: { region?: string }): number {
  const w = DOMAIN_WEIGHT[type] ?? 0.5;
  // A same-named bar on another continent matters little unless you named a launch region.
  return type === "urn:entity:place" && !audience?.region ? Number((w * 0.6).toFixed(3)) : w;
}

export function heatOf(n: { similarity: number; type: string; popularity?: number }, salience: number | null, domainWeight?: number): number {
  const domain = domainWeight ?? DOMAIN_WEIGHT[n.type] ?? 0.5;
  const s = salience === null ? 0 : Math.max(0, Math.min(1, salience));
  // How much THIS audience cares dominates; global fame adds a smaller floor.
  const prominence = 0.75 * s + 0.25 * popularityBoost(n.popularity);
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
  const signals = audienceSignals(audience);
  const affinity = new Map<string, number>();
  const rankOf = new Map<string, { rank: number; beyondSample: boolean }>();
  await pool([...byType.entries()], 4, async ([type, list]) => {
    const ids = list
      .sort((a, b) => b.similarity - a.similarity || (b.popularity ?? 0) - (a.popularity ?? 0))
      .slice(0, 25)
      .map((n) => n.id);
    const params: QueryParams = { "filter.type": type, ...signals, "filter.results.entities": ids, take: ids.length };
    try {
      const [body, cal] = await Promise.all([client.get("/v2/insights", params), calibrate(client, type, signals)]);
      for (const [id, a] of parseAffinities(body)) {
        affinity.set(id, a);
        const r = estimateRank(a, cal);
        if (r) rankOf.set(id, r);
      }
    } catch {
      // leave unscored; surfaced as audienceAffinity=null
    }
  });
  return namesakes
    .map((n) => {
      const a = affinity.has(n.id) ? (affinity.get(n.id) as number) : null;
      const r = rankOf.get(n.id);
      const salience = r ? salienceFromRank(r.rank) : null;
      const proximity = domainWeightFor(n.type, audience);
      const heat = heatOf(n, salience, proximity);
      return {
        ...n,
        audienceAffinity: a,
        audienceRank: r?.rank ?? null,
        rankBeyondSample: r?.beyondSample ?? false,
        salience,
        proximity,
        heat,
        band: bandFor(heat),
      };
    })
    .sort((a, b) => b.heat - a.heat);
}

export function summarize(name: string, scored: ScoredNamesake[], variants: string[]): NameScan {
  const top = scored[0];
  const heat = top?.heat ?? 0;
  const notes: string[] = [];
  if (scored.length === 0) notes.push("No namesakes found in Qloo's cultural graph for this name or its spelling variants.");
  const unscored = scored.filter((s) => s.salience === null).length;
  if (unscored) notes.push(`${unscored} namesake(s) had no audience rank from Qloo; they are rated on popularity only.`);
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
