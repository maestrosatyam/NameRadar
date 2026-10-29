import { QlooEntitySchema } from "../qloo/types";
import type { ResolvedEntity } from "./types";

/** The video game URN differs between the hackathon guide and the official harness; overridable after a live probe. */
export const VIDEO_GAME_TYPE = process.env.QLOO_VIDEO_GAME_TYPE ?? "urn:entity:videogame";

/** Map a /search result type onto the Insights `filter.type` vocabulary. */
export function toInsightsType(types: string[]): string | undefined {
  for (const raw of types) {
    const t = raw.toLowerCase();
    if (t.startsWith("urn:entity:place")) return "urn:entity:place";
    if (t === "urn:entity:artist" || t === "urn:entity:music_artist") return "urn:entity:artist";
    if (t === "urn:entity:brand") return "urn:entity:brand";
    if (t === "urn:entity:movie") return "urn:entity:movie";
    if (t === "urn:entity:tv_show") return "urn:entity:tv_show";
    if (t === "urn:entity:book") return "urn:entity:book";
    if (t === "urn:entity:podcast") return "urn:entity:podcast";
    if (t === "urn:entity:destination") return "urn:entity:destination";
    if (t === "urn:entity:videogame" || t === "urn:entity:video_game") return VIDEO_GAME_TYPE;
    if (["urn:entity:person", "urn:entity:actor", "urn:entity:director", "urn:entity:author"].includes(t)) {
      return "urn:entity:person";
    }
  }
  return undefined;
}

export const TYPE_LABEL: Record<string, string> = {
  "urn:entity:artist": "Music",
  "urn:entity:brand": "Brand",
  "urn:entity:movie": "Film",
  "urn:entity:tv_show": "TV",
  "urn:entity:book": "Book",
  "urn:entity:podcast": "Podcast",
  "urn:entity:place": "Place",
  "urn:entity:destination": "Destination",
  "urn:entity:person": "Person",
  "urn:entity:videogame": "Game",
  "urn:entity:video_game": "Game",
};

/**
 * How directly a namesake in this domain competes for the same mental slot as a
 * new commercial brand. A transparent, fixed prior (documented in docs/LLD.md),
 * not a Qloo output.
 */
export const DOMAIN_WEIGHT: Record<string, number> = {
  "urn:entity:brand": 1,
  "urn:entity:place": 0.85,
  "urn:entity:artist": 0.75,
  "urn:entity:podcast": 0.7,
  "urn:entity:tv_show": 0.7,
  "urn:entity:movie": 0.7,
  "urn:entity:videogame": 0.7,
  "urn:entity:video_game": 0.7,
  "urn:entity:person": 0.6,
  "urn:entity:book": 0.55,
  "urn:entity:destination": 0.4,
};

export function resultsArray(body: unknown, key: string): unknown[] {
  const results = (body as { results?: unknown })?.results;
  if (Array.isArray(results)) return results;
  if (results && typeof results === "object") {
    const v = (results as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

export function parseEntities(body: unknown, key = "entities"): ResolvedEntity[] {
  const out: ResolvedEntity[] = [];
  for (const raw of resultsArray(body, key)) {
    const parsed = QlooEntitySchema.safeParse(raw);
    if (!parsed.success) continue;
    const e = parsed.data;
    const rawTypes = [...(e.types ?? []), ...(e.type ? [e.type] : []), ...(e.subtype ? [e.subtype] : [])];
    const type = toInsightsType(rawTypes);
    if (!type) continue;
    out.push({
      id: e.entity_id,
      name: e.name,
      type,
      rawTypes,
      popularity: e.popularity,
      disambiguation: e.disambiguation ?? e.properties?.short_description ?? e.properties?.address,
      imageUrl: e.properties?.image?.url,
    });
  }
  return out;
}

/** Affinity per entity id from an Insights response. */
export function parseAffinities(body: unknown): Map<string, number> {
  const map = new Map<string, number>();
  for (const raw of resultsArray(body, "entities")) {
    const parsed = QlooEntitySchema.safeParse(raw);
    if (!parsed.success) continue;
    const a = parsed.data.query?.affinity;
    if (typeof a === "number") map.set(parsed.data.entity_id, a);
  }
  return map;
}
