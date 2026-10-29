import {
  INSIGHTS_ENTITY_TYPES,
  INSIGHTS_SPECIAL_TYPES,
  QlooError,
  type InsightsFilterType,
  type QueryParams,
} from "./types";

/**
 * Qloo silently ignores parameters that a given `filter.type` does not support,
 * which turns a typo or an invalid combination into a plausible-looking but
 * unpersonalised 200 response. This validator is deliberately strict: it only
 * allows parameter/type combinations that this app relies on and that the
 * official docs describe, and it rejects everything else *before* the request
 * leaves the server.
 */

const COMMON_ENTITY_PARAMS = new Set([
  "filter.type",
  "signal.interests.entities",
  "signal.interests.entities.weight",
  "signal.interests.tags",
  "signal.interests.tags.weight",
  "operator.signal.interests.tags",
  "signal.location",
  "signal.location.query",
  "signal.location.radius",
  "signal.location.weight",
  "signal.demographics.age",
  "signal.demographics.gender",
  "signal.demographics.audiences",
  "signal.demographics.audiences.weight",
  "filter.tags",
  "operator.filter.tags",
  "filter.exclude.tags",
  "operator.filter.exclude.tags",
  "filter.exclude.entities",
  "filter.results.entities",
  "filter.popularity.min",
  "filter.popularity.max",
  "feature.explainability",
  "diversify.by",
  "diversify.take",
  "bias.trends",
  "take",
  "page",
  "offset",
  "sort_by",
]);

/** Location filtering is only meaningful for geo-bearing entity types. */
const LOCATION_FILTER_PARAMS = new Set([
  "filter.location",
  "filter.location.query",
  "filter.location.radius",
  "filter.location.geohash",
  "filter.exclude.location",
  "filter.exclude.location.query",
  "filter.geocode.country_code",
  "filter.geocode.admin1_region",
  "filter.geocode.admin2_region",
  "filter.geocode.name",
]);
const PLACE_ONLY_PARAMS = new Set([
  "bias.quality",
  "filter.address",
  "filter.price_level.min",
  "filter.price_level.max",
  "filter.properties.business_rating.min",
]);
const GEO_TYPES = new Set<string>(["urn:entity:place", "urn:entity:destination"]);

const SPECIAL_PARAMS: Record<string, Set<string>> = {
  "urn:heatmap": new Set([
    "filter.type",
    "signal.interests.entities",
    "signal.interests.tags",
    "signal.demographics.age",
    "signal.demographics.gender",
    "signal.location.query",
    "filter.location",
    "filter.location.query",
    "output.heatmap.boundary",
    "take",
    "page",
  ]),
  "urn:tag": new Set([
    "filter.type",
    "signal.interests.entities",
    "filter.tag.types",
    "filter.parents.types",
    "take",
    "page",
  ]),
  "urn:demographics": new Set([
    "filter.type",
    "signal.interests.entities",
    "signal.interests.tags",
  ]),
};

const SIGNAL_KEYS = [
  "signal.interests.entities",
  "signal.interests.tags",
  "signal.location.query",
  "signal.demographics.age",
  "signal.demographics.gender",
];

// Documented in the Qloo Parameter Reference (signal.demographics.age).
const AGE_BUCKETS = ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"];

const UUID_LIKE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const TAG_URN = /^urn:tag:[a-z0-9_:.\-]+$/i;

export function isInsightsFilterType(value: unknown): value is InsightsFilterType {
  return (
    typeof value === "string" &&
    ((INSIGHTS_ENTITY_TYPES as readonly string[]).includes(value) ||
      (INSIGHTS_SPECIAL_TYPES as readonly string[]).includes(value))
  );
}

function asList(value: QueryParams[string]): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value as string[];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function validateInsightsParams(params: QueryParams): void {
  const type = params["filter.type"];
  if (!isInsightsFilterType(type)) {
    throw new QlooError(
      "VALIDATION",
      `filter.type "${String(type)}" is not a documented Insights type. Use one of: ${[
        ...INSIGHTS_ENTITY_TYPES,
        ...INSIGHTS_SPECIAL_TYPES,
      ].join(", ")}`,
    );
  }

  const allowed =
    SPECIAL_PARAMS[type] ??
    new Set([
      ...COMMON_ENTITY_PARAMS,
      ...(GEO_TYPES.has(type) ? LOCATION_FILTER_PARAMS : []),
      ...(type === "urn:entity:place" ? PLACE_ONLY_PARAMS : []),
    ]);

  const unsupported = Object.keys(params).filter(
    (k) => params[k] !== undefined && !allowed.has(k),
  );
  if (unsupported.length > 0) {
    throw new QlooError(
      "VALIDATION",
      `Parameter(s) ${unsupported.join(", ")} are not supported with filter.type=${type} and would be silently ignored by Qloo.`,
    );
  }

  const hasSignal = SIGNAL_KEYS.some((k) => asList(params[k]).length > 0);
  if (type !== "urn:tag" && !hasSignal && asList(params["filter.tags"]).length === 0) {
    throw new QlooError(
      "VALIDATION",
      `Insights request for ${type} has no signal or tag filter; it would return generic popularity, not taste-grounded results.`,
    );
  }
  if (type === "urn:tag" && asList(params["signal.interests.entities"]).length === 0) {
    throw new QlooError("VALIDATION", "urn:tag taste analysis requires signal.interests.entities.");
  }

  for (const id of [
    ...asList(params["signal.interests.entities"]),
    ...asList(params["filter.results.entities"]),
    ...asList(params["filter.exclude.entities"]),
  ]) {
    if (!UUID_LIKE.test(id)) {
      throw new QlooError("VALIDATION", `"${id}" is not a Qloo entity id; resolve names through /search first.`);
    }
  }
  for (const tag of [
    ...asList(params["signal.interests.tags"]),
    ...asList(params["filter.tags"]),
    ...asList(params["filter.exclude.tags"]),
  ]) {
    if (!TAG_URN.test(tag)) {
      throw new QlooError("VALIDATION", `"${tag}" is not a Qloo tag URN; resolve tags through /v2/tags first.`);
    }
  }

  const take = params.take;
  if (take !== undefined) {
    const n = Number(take);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      throw new QlooError("VALIDATION", `take must be an integer between 1 and 50 (got ${String(take)}).`);
    }
  }
  for (const age of asList(params["signal.demographics.age"])) {
    if (!AGE_BUCKETS.includes(age)) {
      throw new QlooError("VALIDATION", `Unsupported signal.demographics.age value "${age}".`);
    }
  }
  const gender = params["signal.demographics.gender"];
  if (gender !== undefined && !["male", "female"].includes(String(gender))) {
    throw new QlooError("VALIDATION", `Unsupported signal.demographics.gender value "${String(gender)}".`);
  }
}
