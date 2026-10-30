# Low-level design

## HTTP API

All routes are Node.js route handlers. Inputs are validated with Zod; invalid input returns `400`
with up to 5 issues. Rate-limited routes return `429` with `Retry-After`.

| Route | Method | Input | Output | Limits |
|---|---|---|---|---|
| `/api/run` | POST | `RunRequest` (below) | `application/x-ndjson` stream of `RunEvent` | `RUN_RATE_PER_MIN` per IP (default 3/min, burst 6); `DAILY_RUN_CAP`; 120 Qloo calls per run; `maxDuration` 120 s |
| `/api/search?q=` | GET | 2–80 chars | `{results:[{id,name,domain,hint}]}` | 40/min per IP, 1 Qloo call, 6 s timeout |
| `/api/inspect` | POST | `{entity:{id(UUID),name,type(enum)}, audience}` | `{detail: CollisionDetail, calls}` | 6/min per IP, 10 Qloo calls |
| `/api/baseline` | POST | `{name, category, audienceLabel, anchors[1..4]}` | `BaselineResult` | 4/min per IP; 503 without an LLM key |
| `/api/health` | GET | – | `{ok, qlooConfigured, llmConfigured, model, commit}` | – |

```ts
RunRequest = {
  names: string[1..5] (each 1..40 chars),
  category: string 2..120,
  brief?: string ≤400,
  audience: { label 1..60, anchors: string[1..4] (≤80), ageBuckets?: AgeBucket[≤3], region?: 2..60 },
  mode: "agent" | "scan" = "agent",
  targetClean: 1..5 = 3,
}
RunEvent = status | audience | qloo_call | scan | collision_detail | agent_thought | tool_use | final | error | done
```

## Qloo request shapes (exactly what we send)

| Purpose | Request |
|---|---|
| Resolve an audience anchor | `GET /search?query=<anchor>&take=8` → choose an exact-name match, else the most popular |
| Find namesakes | `GET /search?query=<variant>&take=30` for up to 4 variants (original, squashed, no article, agent-supplied) |
| Audience affinity of namesakes | `GET /v2/insights?filter.type=<T>&signal.interests.entities=<anchor ids>[&signal.demographics.age=<buckets>][&signal.location.query=<region>]&filter.results.entities=<≤25 namesake ids of type T>&take=<n>`, one call per namesake type |
| Connotation | `GET /v2/insights?filter.type=urn:tag&signal.interests.entities=<id>&take=12` |
| Fan demographics | `GET /v2/insights?filter.type=urn:demographics&signal.interests.entities=<id>` (namesake, then audience anchors) |

Arrays are comma-joined (GET form documented in the Parameter Reference). Parameters are sorted
before building the URL so cache keys are stable.

## Validation (`src/lib/qloo/validate.ts`)

Qloo silently ignores parameters a type does not support. We therefore allow-list
parameters per `filter.type`:

- **Entity types:** signals (`signal.interests.*`, `signal.location*`, `signal.demographics.*`),
  tag filters/operators, `filter.results.entities`, `filter.exclude.entities`, popularity bounds,
  `feature.explainability`, `diversify.*`, `bias.trends`, `take` (1–50), `page`, `offset`, `sort_by`.
- **Geo types only** (`place`, `destination`): `filter.location*`, `filter.geocode.*`,
  `filter.exclude.location*`.
- **Place only:** `bias.quality`, `filter.address`, price/rating filters.
- **Special types:** `urn:heatmap`, `urn:tag` and `urn:demographics` each have their own small
  allow-list.
- Every entity request must carry a signal or tag filter. Without one, results would be generic
  popularity rather than taste-grounded.
- Entity ids must be UUIDs and tags must be `urn:tag:` URNs, which catches names passed where ids
  belong. Age buckets are checked against the documented enum.

Violations throw before any network call, and are logged in the evidence trail as
`validation_error`.

## Matching (`src/lib/radar/match.ts`)

Names are normalised (NFKD, lowercase, punctuation stripped, `&`→`and`, leading article dropped).

| Kind | Rule | Similarity |
|---|---|---|
| exact | equal, or equal with spaces removed | 1.0 |
| contains_word | candidate is a whole-word run in the entity name | 0.8 (1 extra word), 0.65 (2), 0.5 (3+) |
| contains_word (reverse) | entity name (≥4 chars) is a whole-word run in the candidate | 0.6 |
| near_spelling | Levenshtein ratio ≥ 0.75 on squashed strings (≥4 chars) | 0.85 × ratio |
| inside_word | candidate (≥5 chars) is the prefix of a slightly longer token | 0.4 |

Search hits that match none of these rules are discarded, so they are not treated as namesakes.

## Scoring (`src/lib/radar/scan.ts`, `calibrate.ts`)

```
rank      = estimated rank of the namesake in THIS audience's own Qloo ranking for its domain
            (raw query.affinity placed on a live calibration curve: Insights pages 1, 4, 20 (+100) of take=50)
salience  = clamp(1 − log10(rank/25) / log10(5000/25))        # 1 at rank ≤25, 0 at rank ≥5,000
fame      = clamp((popularity − 0.8) / 0.2)                   # popularity is a percentile; most hits are >0.8
heat      = similarity × domainWeight × (0.75 × salience + 0.25 × fame)
verdict   = red if max heat ≥ 0.45, amber if ≥ 0.20, else green
```

- Why rank and not raw affinity: raw affinity is compressed (top-50 ≈ 0.9, rank 5,000 ≈ 0.7; see
  [QLOO_API_CONFORMANCE.md](QLOO_API_CONFORMANCE.md#calibration-why-raw-affinity-is-not-used-directly)).
- A missing affinity or calibration gives `salience = null`, which is treated as 0 with a visible note.
  It is never imputed as hot.
- `domainWeight` is a fixed, documented prior: brand 1.0, place 0.85 (×0.6 without a launch
  region, because a same-named bar abroad matters little), music 0.75, podcast/TV/film/game 0.7,
  person 0.6, book 0.55, destination 0.4.
- Fame contributes at most 0.25, so a world-famous namesake the audience ignores lands in amber
  ("crowded"), not green.

The UI shows every term for any namesake.

## Agent tools (`src/lib/radar/agent.ts`)

| Tool | Input (strict JSON schema + Zod) | Server behaviour |
|---|---|---|
| `scan_names` | `{names: string[1..4]}` | Screens new names (budget: 12 per run), reuses earlier scans, emits `scan` events, returns compact scan JSON |
| `inspect_collision` | `{entity_id}` | Accepts only ids returned by earlier scans in this run; returns tags and demographics |
| `submit_report` | `{shortlist[1..6]{name, rationale, evidence_ids}, memo ≤4000, attorney_questions ≤6}` | Rejects unscreened names; replaces verdicts with scan verdicts; drops evidence ids not seen in this run |

Model `claude-opus-5-5` (configurable). Effort `low` by default for latency. Server-side refusal
fallback is enabled (`fallbacks: "default"`). The system prompt is cached. The loop runs at most
8 turns, and stops on `refusal` or truncation.

## Caching

A process-wide TTL+LRU cache (2000 entries, 6 h), keyed by path plus sorted query string. Only
successful responses are cached. It is private to the server, never persisted, and never
committed.

## Error model

`QlooError.code ∈ {CONFIG, AUTH, FORBIDDEN_TYPE, RATE_LIMITED, NOT_FOUND, BAD_REQUEST, UPSTREAM,
NETWORK, TIMEOUT, VALIDATION, BUDGET}`. Messages never include headers or keys; upstream bodies
are truncated to 300 characters.

## Tests

- `tests/unit/qloo_contract.test.ts`: request shape, host, auth header, endpoint allow-list,
  validation of silently-ignored combinations, retries, Retry-After cap, budget, cache, key
  non-leakage.
- `tests/unit/radar.test.ts`: matching table, type mapping, defensive parsing, heat monotonicity,
  audience-conditional verdict flip, graceful degradation.
- `tests/e2e/journey.spec.ts`: full visitor journey, flip, drill-down, validation, API abuse
  (desktop and Pixel 7). Runs against MOCK by default, or a live URL via `E2E_BASE_URL`.
- `scripts/smoke_qloo.ts`: live conformance probe. `scripts/eval_ablation.ts`: live ablation.
