import { z } from "zod";

/**
 * Insights `filter.type` values listed in the official hackathon developer guide
 * (https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide).
 * `urn:heatmap`, `urn:tag` and `urn:demographics` are documented special-purpose
 * Insights types (heatmaps / taste-analysis / demographics use cases).
 */
export const INSIGHTS_ENTITY_TYPES = [
  "urn:entity:artist",
  "urn:entity:book",
  "urn:entity:brand",
  "urn:entity:destination",
  "urn:entity:movie",
  "urn:entity:person",
  "urn:entity:place",
  "urn:entity:podcast",
  "urn:entity:tv_show",
  "urn:entity:video_game",
  // The official @qloo/qloo-harness uses this spelling; the hackathon guide uses
  // `video_game`. Both are accepted here until a live probe settles it
  // (see docs/QLOO_API_CONFORMANCE.md).
  "urn:entity:videogame",
] as const;

export const INSIGHTS_SPECIAL_TYPES = ["urn:heatmap", "urn:tag", "urn:demographics"] as const;

export type InsightsEntityType = (typeof INSIGHTS_ENTITY_TYPES)[number];
export type InsightsSpecialType = (typeof INSIGHTS_SPECIAL_TYPES)[number];
export type InsightsFilterType = InsightsEntityType | InsightsSpecialType;

export type QueryValue = string | number | boolean | readonly string[] | undefined;
export type QueryParams = Record<string, QueryValue>;

const geocode = z
  .object({
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    country_code: z.string().optional(),
    admin1_region: z.string().optional(),
    admin2_region: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const QlooTagSchema = z
  .object({
    id: z.string().optional(),
    tag_id: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    subtype: z.string().optional(),
    value: z.string().optional(),
  })
  .passthrough();

export const QlooEntitySchema = z
  .object({
    entity_id: z.string(),
    name: z.string(),
    type: z.string().optional(),
    subtype: z.string().optional(),
    types: z.array(z.string()).optional(),
    popularity: z.number().optional(),
    disambiguation: z.string().optional(),
    location: z
      .object({ lat: z.number().optional(), lon: z.number().optional(), geohash: z.string().optional() })
      .passthrough()
      .optional(),
    properties: z
      .object({
        description: z.string().optional(),
        short_description: z.string().optional(),
        address: z.string().optional(),
        geocode: geocode.optional(),
        image: z.object({ url: z.string().optional() }).passthrough().optional(),
        business_rating: z.number().optional(),
        price_level: z.number().optional(),
        is_closed: z.boolean().optional(),
        website: z.string().optional(),
      })
      .passthrough()
      .optional(),
    tags: z.array(QlooTagSchema).optional(),
    query: z
      .object({
        affinity: z.number().optional(),
        measurements: z.record(z.string(), z.unknown()).optional(),
        distance: z.number().optional(),
        explainability: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type QlooEntity = z.infer<typeof QlooEntitySchema>;
export type QlooTag = z.infer<typeof QlooTagSchema>;

export const HeatmapPointSchema = z
  .object({
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        geohash: z.string().optional(),
      })
      .passthrough(),
    query: z
      .object({
        affinity: z.number().optional(),
        affinity_rank: z.number().optional(),
        popularity: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type HeatmapPoint = z.infer<typeof HeatmapPointSchema>;

/** One entry of the per-request call log that powers the provenance panel. */
export interface QlooCallRecord {
  id: string;
  path: string;
  params: Record<string, string>;
  status: number | "network_error" | "timeout" | "validation_error";
  ok: boolean;
  cached: boolean;
  latencyMs: number;
  resultCount: number;
  attempts: number;
  error?: string;
  at: string;
}

export class QlooError extends Error {
  constructor(
    public readonly code:
      | "CONFIG"
      | "AUTH"
      | "FORBIDDEN_TYPE"
      | "RATE_LIMITED"
      | "NOT_FOUND"
      | "BAD_REQUEST"
      | "UPSTREAM"
      | "NETWORK"
      | "TIMEOUT"
      | "VALIDATION"
      | "BUDGET",
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "QlooError";
  }
}
