# NameRadar

**Is your brand name already taken in your customers' heads?**

NameRadar is a naming agent grounded in [Qloo](https://www.qloo.com/)'s taste graph. Trademark
search tells you who *registered* a word. NameRadar tells you who *owns it culturally*: the band,
film, show, game, podcast, book, place or brand that **your** target customers already love.
When a name is taken, its agent invents alternatives and screens each one against Qloo until it
finds names that are clear for your audience.

> Cultural pre-screen only: **not legal advice or trademark clearance.**

- **Licence:** MIT

## Why Qloo is essential

Ask an LLM whether "Tidal" is a good name for an energy drink and it will recall Jay-Z's
streaming service. It gives that answer regardless of who you're selling to. NameRadar asks Qloo
the question that matters: *how much does this audience care about each thing already called
that?*

```
GET /search?query=Tidal                                  → every namesake in 250M+ entities
GET /v2/insights?filter.type=<type>
               &signal.interests.entities=<what your audience loves>
               &filter.results.entities=<the namesakes>  → audience-specific affinity per namesake
```

The **same name can be red for one audience and green for another**. The app shows this with the
*Flip the audience* control and with an in-product **LLM-only comparison**: the same model without
Qloo, with each namesake it claims checked against Qloo.

## What the agent does

1. **Resolves your audience** in Qloo from 1–4 things they love (plus optional age and region).
2. **Finds namesakes** for each candidate name and its spelling variants (`/search`).
3. **Scores each namesake for your audience** (`/v2/insights` with `filter.results.entities`):
   `heat = match × domain × (0.75·audience salience + 0.25·global fame), where salience comes from the namesake's estimated rank in your audience's own Qloo ranking`, shown term by term.
4. **Explains collisions**: what the namesake means to its fans (`urn:tag` taste analysis) and
   whether its fans look like yours (`urn:demographics`).
5. **Fixes the problem**: proposes alternatives and screens every one with Qloo before recommending
   it. With `ANTHROPIC_API_KEY` set, an LLM tool-use agent does the ideation (`scan_names`,
   `inspect_collision`, `submit_report`); otherwise a deterministic planner runs. Either way the
   server rejects unscreened names and locks verdicts to Qloo scans.
6. **Hands off** a memo with questions for a trademark attorney (Markdown export).

Every Qloo request (endpoint, parameters, status, latency, cache hit) is listed in the in-app
**Evidence trail**. The key is never shown.

## Using the app

1. Click **Energy drink · hip-hop fans**, then **Scan names**.
2. Click any namesake to see why it scored as it did.
3. Under **Flip the audience**, click **Re-score for this audience** and toggle between audiences.
4. Click **Compare: what does an LLM alone say?** on any card (needs an LLM key on the server).
5. Try your own: what you're launching, what your customers love, and your name ideas.

## Architecture

Next.js 16 (App Router). All Qloo and LLM calls happen in server route handlers.

```
src/lib/qloo/      typed Qloo client: configurable host, X-Api-Key, strict per-type parameter
                   validation (Qloo silently ignores unsupported params), retries/backoff,
                   per-run call budgets, private TTL cache, call log for provenance
src/lib/radar/     audience resolution, namesake matching, audience-conditional scoring,
                   LLM tool-use agent (+ deterministic fallback), LLM-only baseline
src/app/api/       run (NDJSON stream), search, inspect, baseline, health
src/components/    radar SVG, audience editor, results UI
```

Design docs: [Product spec](docs/PRODUCT_SPEC.md) · [HLD](docs/HLD.md) · [LLD](docs/LLD.md) ·
[Qloo API conformance](docs/QLOO_API_CONFORMANCE.md) · [Security & privacy](docs/SECURITY_PRIVACY_LICENSES.md) ·
[Evaluation](docs/ABLATIONS_AND_EVALUATION.md)

## Run locally

```bash
npm install
cp .env.example .env.local   # add QLOO_API_KEY and, optionally, ANTHROPIC_API_KEY
npm run dev                  # http://localhost:3000
```

Without any keys, you can run everything against the **MOCK** Qloo server (synthetic data, clearly
labelled):

```bash
npm run mock:qloo &                                   # :4010
QLOO_API_URL=http://localhost:4010 QLOO_API_KEY=mock npm run dev
```

### Docker

The `Dockerfile` builds a Next.js standalone server listening on port 8080:

```bash
docker build -t nameradar .
docker run -p 8080:8080 -e QLOO_API_KEY=... nameradar
```

## Tests and evaluation

```bash
npm run typecheck && npm run lint
npm test                      # unit + Qloo contract tests (vitest)
npm run test:e2e              # Playwright, desktop + mobile, against MOCK
E2E_BASE_URL=https://<deployment> npx playwright test   # against a deployment
npm run smoke:qloo            # live Qloo conformance probe -> evidence/qloo_live_api_probe.json
npm run eval                  # live ablation (LLM-only vs registry vs Qloo vs agent) -> evals/results/
```

The repository never contains Qloo response data (Qloo policy). The probe and evaluation scripts
write sanitized metadata only, to git-ignored folders.

## Limitations

- Qloo `/search` is name search, not phonetic search. NameRadar adds spelling variants and the
  agent can add more, but sound-alike collisions can still be missed.
- Very small or local namesakes may not be in Qloo's graph. *Green* means "no namesake your
  audience strongly cares about in Qloo", not "unused anywhere".
- Affinity is an aggregate taste signal, not a measure of legal confusion. Talk to a trademark
  attorney before you file.
- The default `QLOO_API_URL` is the host the original Qloo developer keys were issued for. Set
  `QLOO_API_URL` to the host your key works against, or run in MOCK mode.
