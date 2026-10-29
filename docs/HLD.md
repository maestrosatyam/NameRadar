# High-level design

```
Browser (Next.js client)                 Vercel (Node.js functions)                    External
──────────────────────────               ───────────────────────────────               ─────────────────────────
NameRadarApp ──POST /api/run──────────▶  run route ──▶ resolveAudience ──GET /search──▶ hackathon.api.qloo.com
  ▲  NDJSON event stream                   │            scanName       ──GET /search──▶   (X-Api-Key, server-only)
  │  (status, qloo_call, scan,             │                           ──GET /v2/insights (filter.results.entities)
  │   tool_use, final, done)               │            runAgent ──────────────────────▶ Anthropic Messages API
  │                                        │              tools: scan_names,             (Claude, tool use)
  │                                        │                     inspect_collision ─GET /v2/insights urn:tag / urn:demographics
  │                                        │                     submit_report
  │                                        └─ fallback: runDeterministic (no LLM)
AudienceEditor ──GET /api/search────────▶  search route (rate-limited proxy) ──GET /search
CollisionPanel ──POST /api/inspect──────▶  inspect route ──GET /v2/insights (urn:tag, urn:demographics)
NameCard ──POST /api/baseline───────────▶  baseline route ──▶ Claude without tools; claims checked via GET /search
                                          health route (GET /api/health): config booleans only
```

## Components

| Component | Responsibility | File |
|---|---|---|
| Qloo client | Only path to Qloo. Hackathon host, `X-Api-Key`, endpoint allow-list, strict parameter validation, bounded retries (429/5xx with capped Retry-After), timeouts, per-run call budget, private TTL/LRU cache, call log for provenance | `src/lib/qloo/client.ts`, `validate.ts`, `cache.ts` |
| Radar engine | Audience resolution, namesake discovery and matching, audience-conditional scoring, collision inspection | `src/lib/radar/scan.ts`, `match.ts`, `entities.ts` |
| Agent | Claude tool-use loop with three tools; validates every tool input; verdicts always come from scans; deterministic planner fallback | `src/lib/radar/agent.ts` |
| Baseline | Same model, no tools: the LLM-only control, with each claim checked against Qloo | `src/lib/radar/baseline.ts` |
| API routes | Zod-validated inputs, rate limits, NDJSON streaming, error mapping | `src/app/api/*/route.ts` |
| UI | Form, live timeline, radar SVG, namesake drill-down, audience flip, LLM-only comparison, evidence trail, memo export | `src/components/*` |

## Agent runtime and decisions

1. **Deterministic first pass** (no LLM): resolve the audience, then scan the user's names. This is
   fast, cheap, reproducible and streamed immediately.
2. **Agent pass** (Claude via tool use): receives the brief, resolved audience and scans. It
   decides which collisions to inspect, invents candidate names, and screens them with
   `scan_names`, under a budget of 12 agent names and 8 turns. It finishes with `submit_report`.
   The server rejects reports that cite unscreened names, overwrites each verdict with the scan's
   verdict, and filters evidence ids to those actually returned by Qloo.
3. **Fallback:** if no LLM key is configured or the LLM fails, a heuristic planner generates
   variants, screens them with Qloo, and labels the report `planner: deterministic`.

This split is deliberate: Qloo evidence and scoring are deterministic and auditable, while the LLM
does what LLMs are good at (inventing names, explaining) and cannot change the evidence.

## State

Stateless. No database, no accounts, nothing persisted per user. Each Node.js instance keeps a
private in-memory cache of Qloo responses (TTL 6 h, at most 2000 entries), as the hackathon guide
allows. It is never written to disk or to the repository.

## Trust boundaries

- Qloo and Anthropic keys exist only in server environment variables.
- User text (brief, category, names) is untrusted. It is length-limited by Zod, wrapped in
  `<user_brief>` and declared as data in the system prompt, and never interpolated into Qloo
  paths (only into query values, which `URLSearchParams` encodes).
- Qloo entity names are third-party data. They are rendered as text, never as HTML. LLM output
  goes through a no-HTML markdown renderer.
- Agent tools are read-only and can only reference entity ids that Qloo returned in this run. The
  agent has no network, file or code-execution access.

## Failure paths

| Failure | Behaviour |
|---|---|
| Qloo 401 | Run ends with a clear "credential rejected" error; nothing is fabricated |
| Qloo 403 for a type | That type's namesakes stay unscored (affinity n/a), and a note says so |
| Qloo 429/5xx | Up to 3 attempts with backoff (Retry-After capped at 5 s), then a typed error |
| Qloo timeout (15 s) | Retried, then surfaced in the evidence trail as `timeout` |
| LLM error or refusal | Deterministic planner takes over; the timeline says why |
| Per-run Qloo budget hit (120) | Typed `BUDGET` error; the agent is told to submit with names already screened |
| Abuse | Per-IP token buckets per route, global daily run cap, input size caps |

## Deployment and cost

Vercel (Hobby tier, Node.js runtime, `maxDuration` 120 s on `/api/run`). Typical agent run:
around 25–60 Qloo calls (many cached) and 3–6 LLM calls. Model and effort are set by environment
variables (`ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT`).
