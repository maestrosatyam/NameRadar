# Product spec: NameRadar

## User and problem

**Primary users:** founders naming a company or product, indie consumer brands launching a line,
product marketers, and naming/branding agencies doing early screening.

**Problem:** a new name can already be *culturally owned* by something the target customers
love: a band, film, show, podcast, game, book, restaurant or brand. The results are confusion,
being buried in search results, unwanted connotations, and sometimes a forced rebrand. Existing
tools check registered marks (as strings) and domain availability. None answers the question
founders actually have:

> *Do the people I'm selling to already associate this word with something else they love, and
> how strongly?*

## Jobs to be done

1. "Before I fall in love with a name, tell me whether my customers already know it as something else."
2. "Show me why, with evidence I can check, not a vibe."
3. "If it's taken, give me alternatives that are clear for *my* audience."
4. "Give me something I can hand to a co-founder or a trademark attorney."

## Non-goals

- Legal trademark clearance or legal advice. NameRadar is a cultural pre-screen; the memo
  says so and lists questions for an attorney.
- Domain or social-handle availability.
- Inferring anything about individuals. Qloo affinities are aggregate taste signals.

## End-to-end narrative (user journey)

1. Open the app. No sign-in.
2. Click a scenario (e.g. *Energy drink · hip-hop fans*) or type their own: what they're launching,
   1–4 things their customers love (autocomplete from Qloo search), optional age and region, and
   1–5 name ideas.
3. **Scan names.** The agent timeline streams each step. Each name gets a card: verdict
   (RED *taken for this audience* / AMBER *crowded* / GREEN *clear for this audience*), a radar
   of namesakes by domain (closer to centre = hotter for this audience), and the top namesakes
   with audience-affinity and popularity bars.
4. Click a namesake: the panel shows the exact scoring formula with each input and its source,
   plus what the namesake means to its fans (Qloo taste tags) and its fans' age skew compared with
   the user's audience (Qloo demographics).
5. The agent proposes alternative names, screens each one with Qloo, and returns a shortlist with
   rationales citing Qloo entity ids, a short memo, and questions for a trademark attorney.
   **Download memo** exports Markdown.
6. **Flip the audience:** re-score the same names for a contrasting audience and see verdicts
   change.
7. **Compare with LLM-only:** the same model without Qloo gives one audience-blind verdict; each
   namesake it claims is checked against Qloo (✓ exists / ? not found).
8. **Evidence trail:** every Qloo request (endpoint, parameters, status, result count, latency,
   cache hit), with the key never shown.

## Acceptance criteria

| # | Criterion | How verified |
|---|---|---|
| A1 | A first-time visitor completes a scan from a preset with no setup | Playwright `journey.spec.ts` (desktop + mobile); live smoke against the deployed URL |
| A2 | Every verdict traces to Qloo calls visible in the evidence trail | E2E asserts `/search` and `/v2/insights` rows; UI shows params |
| A3 | Changing the audience changes Qloo signals and can change verdicts | Unit test `flips verdict when the audience changes`; live flip-rate measurement |
| A4 | The agent never recommends an unscreened name; verdicts come from scans, not the LLM | `submit_report` validation in `agent.ts` rejects unscreened names and overwrites verdicts with scan results |
| A5 | No Qloo or LLM key reaches the browser, logs, or repo | Contract test "never leaks the API key"; E2E HTML check; secret scan before push |
| A6 | Works without an LLM (deterministic planner) and degrades when Qloo is slow or rate-limited | Unit tests for 429/timeout/500; planner fallback path |
| A7 | Invalid or abusive input is rejected | Zod schemas, E2E `API rejects malformed and oversized input`, rate limits |
| A8 | Accessible: keyboard operable, labelled controls, non-colour verdict text, reduced-motion | Manual review and Playwright role-based locators |
