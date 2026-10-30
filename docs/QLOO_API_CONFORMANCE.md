# Qloo API conformance

Status labels: **VERIFIED LIVE** = exercised against `https://hackathon.api.qloo.com` with the team's
hackathon key on 2026-10-30. **DOCUMENTED** = taken from the docs but not separately exercised.
Sanitized probe output (statuses, counts, latencies and response field names only; no Qloo response
data) is written to `evidence/qloo_live_api_probe.json` (git-ignored) by
`npm run smoke:qloo`.

## Host and authentication: VERIFIED LIVE

- Base URL is `https://hackathon.api.qloo.com`. The client refuses non-HTTPS hosts and hosts that
  carry credentials or a query string.
- The key goes in the `X-Api-Key` header only, never in a query parameter, `Authorization`
  header, browser bundle or log. Contract tests assert this.
- All requests are `GET` with query-string parameters. Arrays are comma-joined.

## Endpoints used

| Endpoint | Use in NameRadar | Status | Notes |
|---|---|---|---|
| `GET /search?query=&take=` | Resolve audience anchors and find namesakes | VERIFIED LIVE | Mixed-type results; `types` field is an array. Recall for common words is high (e.g. 21 namesakes for "Tidal", 0 for the coined "Zorvexa") |
| `GET /v2/insights` + `filter.results.entities` | Audience affinity of specific namesakes | VERIFIED LIVE | Returns `query.affinity` and `query.measurements.audience_growth` per entity. **Returns 0 results for `urn:entity:videogame` ids and only a subset for places**; those namesakes fall back to popularity-only scoring with a visible note |
| `GET /v2/insights` + `take=50&page=n` | Calibrate each audience's affinity→rank curve | VERIFIED LIVE | Pages beyond ~rank 1,000 return 0 results for TV, artists and video games; brands and places page to at least rank 5,000 |
| `GET /v2/insights?filter.type=urn:tag` | Connotation of a namesake | VERIFIED LIVE | Tag rows use `tag_id`, `name`, `subtype`, `tag_value` |
| `GET /v2/insights?filter.type=urn:demographics` | Fan age/gender skew | VERIFIED LIVE | One row with `query` age/gender maps |
| `GET /v2/insights` + `feature.explainability=true` | Per-signal contribution | VERIFIED LIVE | Per-result `query.explainability["signal.interests.entities"]` scores, plus a top-level aggregate |
| `GET /v2/tags` (`filter.query`, `feature.semantic_search`) | Probe only | VERIFIED LIVE | |
| `GET /v2/insights?filter.type=urn:heatmap` | Probe only | VERIFIED LIVE | 8,576 geohash cells for one artist across the United States |

## Differences from the published docs (live findings)

| Topic | Hackathon developer guide | Live API (2026-10-30) |
|---|---|---|
| Video game type | `urn:entity:video_game` | **`urn:entity:video_game` → 400; `urn:entity:videogame` → 200.** The official `@qloo/qloo-harness` uses `videogame`. We use `videogame` (overridable with `QLOO_VIDEO_GAME_TYPE`) |
| `output.heatmap.boundary` values | Parameter reference lists "geohashes, city or neighborhood" | 400: *must be `urn:geohash` or `urn:entity:locality`* |
| Silent parameter handling | "Invalid parameters are silently ignored" | Confirmed in spirit: `filter.results.entities` with video game ids returns an empty 200, not an error |

## Calibration: why raw affinity is not used directly

`query.affinity` is compressed. For one audience (anchors: Travis Scott, Kendrick Lamar, Nike), the
brand at rank 50 scored 0.905, rank 200 0.864, rank 1,000 0.789 and rank 5,000 0.686. A coastal
outdoors audience had almost the same curve (0.891 / 0.856 / 0.805 / 0.709). So a raw 0.83 is *not*
"83% liked"; it is roughly the 450th-ranked brand for that audience. NameRadar therefore samples each
audience's own ranking per domain (pages 1, 4, 20, plus 100 for brands and places; cached) and
converts each namesake's affinity into an **estimated rank in that audience's taste** by
log-rank interpolation (`src/lib/radar/calibrate.ts`). Salience is 1 at rank ≤25 and 0 at rank
≥5,000.

Example, VERIFIED LIVE: the TIDAL brand had affinity 0.830 for the hip-hop audience (≈ rank 400)
and 0.643 for the coastal audience (beyond rank 5,000). That difference is what produces the
audience flip.

## Parameter validation

`src/lib/qloo/validate.ts` allow-lists parameters per `filter.type` (from the Parameter Reference),
requires a signal on entity requests, requires UUID entity ids and `urn:tag:` tag ids, enforces
`take` ≤ 50 and the documented age buckets, and rejects location filters on non-geo types. Each rule
has a contract test in `tests/unit/qloo_contract.test.ts`.

## Reliability

- Timeouts of 15 s, up to 3 attempts on 429/5xx with exponential backoff, and `Retry-After` honoured
  but capped at 5 s.
- Per-run upstream budget of 120 calls on the public app.
- Private, in-memory cache (TTL 6 h, at most 2000 entries) that is never persisted or committed.
- Observed latencies (live): `/search` 0.4–2.4 s; Insights 0.3–1.0 s for most types, 1.5–2.6 s
  for places.
- During a deliberately heavy probe (368 calls with up to 12 in flight), 11 calls failed after
  retries, consistent with rate limiting. The public app limits in-flight Qloo requests per run to 4.

## Data policy

The repository contains no Qloo response data. The MOCK server (`scripts/mock_qloo_server.ts`)
generates synthetic data for tests. Evidence files contain sanitized metadata only. Album entities
are excluded from scoring because they are not an Insights `filter.type` and carry no artist link.
