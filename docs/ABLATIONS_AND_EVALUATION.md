# Ablations and evaluation

All numbers below are **VERIFIED LIVE** against `hackathon.api.qloo.com` on 2026-10-30. They are
**proxy metrics**: no human raters were used and none are claimed. Raw per-case output (verdicts and
namesake names/types only, no Qloo affinity payloads) is written to `evals/results/` by `npm run eval` (git-ignored).

## Setup (pre-registered)

`evals/cases.json` was committed on 2026-10-29, **before any live run**:
- 20 candidate names: 16 common words likely to have namesakes, plus 4 coined strings expected to
  be clear.
- 3 contrasting audiences, each defined by three things they love, all resolved in Qloo:
  - **A:** young hip-hop and streetwear fans (Travis Scott, Kendrick Lamar, Nike; ages ≤29)
  - **B:** older coastal and outdoors shoppers (Jimmy Buffett, L.L.Bean, Patagonia; 55+)
  - **C:** cozy gamers and anime fans (Stardew Valley, Animal Crossing, Studio Ghibli)
- 3 audience pairs (A–B, A–C, B–C), giving 60 name × pair comparisons.

Run it with `npm run eval` (all arms) or `npm run eval -- --no-llm`.

| Arm | What it is |
|---|---|
| **A: LLM-only** | Same model, same brief, no Qloo; one verdict per (name, audience) plus claimed namesakes, each checked against Qloo `/search` |
| **B: Registry-only** | Qloo `/search` namesakes scored by match × domain × fame, with **no audience signal**: the equivalent of a string or name-registry check |
| **C: Qloo scan** | NameRadar's deterministic scan: namesakes plus audience-conditional Insights affinity, calibrated to rank |
| **D: Full agent** | C plus LLM ideation and screening loop, end to end |

## Results (run `ablation-2026-10-30T09-09-10-191Z.json`, 365 Qloo calls, 0 errors, 95 s)

| Metric | B: Registry-only | C: Qloo scan |
|---|---|---|
| Verdict changes between contrasting audiences | **0 / 60 (0%)**, audience-blind by construction | **21 / 60 (35%)** |
| Common-word names flagged RED | 16 / 16 | Audience-dependent: 2–3 per audience |
| Coined names (Zorvexa, Quillory, Brumelo, Tavanti) | 3 green, 1 amber | 4 / 4 green for every audience |
| Names with ≥1 namesake found in Qloo | 18 / 20 | same discovery input |

**Qloo signals are actually applied, not silently ignored.** Across 213 (namesake, audience-pair)
comparisons, the raw affinity for the *same* entity differed by a mean of 0.071 between audiences.
51% of pairs differed by more than 0.05. On Qloo's compressed scale (top-50 ≈ 0.90, rank
5,000 ≈ 0.70) that is a large movement; see
[QLOO_API_CONFORMANCE.md](QLOO_API_CONFORMANCE.md#calibration-why-raw-affinity-is-not-used-directly).

### Illustrative per-case verdicts (A / B / C)

| Name | Registry-only | Qloo scan | Driving namesake (live) |
|---|---|---|---|
| Euphoria | red | **red** / amber / **green** | HBO's *Euphoria* ≈ #7 of audience A's TV |
| Nova | red | green / **red** / green | PBS *NOVA* ≈ #43 of audience B's TV |
| Halo | red | amber / amber / **red** | *Halo* franchise ≈ #35 for audience C |
| Tidal | red | **red** / amber / amber | TIDAL brand ≈ #390 of audience A's brands |
| Apex | red | red / amber / red | *Apex Legends* |
| Mercury, Echo, Saturn, Drift, Ember | red | green / green / green | Namesakes exist, but none ranks in these audiences' taste |

**Interpretation.** A string search tells a founder that almost every common word is taken, which
isn't actionable. The Qloo-grounded scan separates "a namesake exists" from "*your* customers care
about it", and the answer depends on the audience in about a third of cases. That is the
falsifiable claim behind NameRadar: remove
Qloo's audience-conditional signal (arm B) and the flip rate drops from 35% to 0%.

## Arms not yet run

- **A (LLM-only) and D (full agent)** need an LLM key on the server. Planned metrics: LLM flip rate,
  share of LLM-claimed namesakes that exist in Qloo, LLM recall of Qloo-red namesakes, agent success
  rate (≥3 green names delivered), latency, Qloo calls and tokens. This section will be updated
  with real numbers or stay marked as not run.

## Limitations and threats to validity

- **No ground truth.** "Taken in customers' heads" has no labelled dataset, and we did not run a
  human panel. The flip rate measures *audience sensitivity*, not correctness. The examples above
  are face-valid (HBO *Euphoria* for young viewers, PBS *NOVA* for older ones), but face validity is
  not accuracy.
- **Thresholds are ours.** Red ≥0.45 and amber ≥0.20, the rank→salience mapping and the domain
  weights were chosen by the team after inspecting live data from audiences A and B on 2026-10-30,
  and then applied unchanged to all 20 names and all three audiences.
- **Rate limiting.** An earlier run the same day (`*.RATE-LIMITED-15x429.json`) had 15 calls fail
  with HTTP 429, which silently weakened some verdicts (e.g. Euphoria/A came out amber). We added a
  process-wide concurrency gate and re-ran. Only the clean run is reported.
- **Coverage.** Albums (not an Insights type) are excluded. Video-game namesakes get no audience
  rank because `filter.results.entities` returns nothing for them, so they are scored on fame
  alone. Small local businesses may be missing from the graph.
- **Drift.** Live Qloo data can change between runs; exact ranks may move.
