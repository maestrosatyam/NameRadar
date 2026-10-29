# Security, privacy and licences

## Secrets

- `QLOO_API_KEY` and `ANTHROPIC_API_KEY` live only in server environment variables (hosting
  provider settings, or a local `.env.local` that is git-ignored). Nothing is prefixed
  `NEXT_PUBLIC_`.
- The Qloo key is sent only as the `X-Api-Key` header to the configured HTTPS host. The client
  refuses non-HTTPS hosts, hosts carrying credentials or query strings, and endpoints outside an
  allow-list.
- Call logs shown in the UI contain the path, query parameters, status, latency and counts, never
  headers. A contract test asserts the key never appears in logs or errors; an E2E test asserts it
  never appears in page HTML.
- Before every push, `git diff --cached` is scanned for key patterns.

## Privacy

- No accounts, cookies or analytics. Nothing a visitor types is stored. Requests live only for the
  duration of a run.
- Only public cultural names (brands, artists, shows) and coarse optional age buckets or regions
  are sent to Qloo, never personal data, as the kit's SAFE_USE guidance requires.
- Qloo affinities are presented as aggregate taste signals, never as predictions about a person.
- The Qloo response cache is in-memory, server-side, bounded (2000 entries, 6 h TTL) and never
  written to disk or the repository. The repository contains no Qloo response data. The MOCK
  server generates synthetic data, and the probe scripts write only sanitized metadata.

## Agent and LLM safety

- User text is length-limited, wrapped in `<user_brief>`, and declared as data in the system
  prompt.
- Tools are read-only Qloo lookups. `inspect_collision` only accepts entity ids returned in the
  same run, so the model cannot make the server fetch arbitrary resources. There are no URL
  fetches, file access or code execution, so no SSRF surface.
- The model cannot change evidence: final verdicts are overwritten with scan verdicts, unscreened
  names are rejected, and evidence ids are filtered.
- LLM output is rendered through a no-HTML markdown renderer (`SafeMarkdown`); entity names are
  rendered as text, so injected HTML cannot reach the DOM.
- Legal framing: the UI, memo and footer state "cultural pre-screen, not legal advice or
  trademark clearance".

## Abuse and cost controls

- Per-IP token buckets per route (run 3/min, burst 6; search 40/min; inspect 6/min; baseline
  4/min). They are in-memory, so per-instance on serverless: best effort, documented.
- Global daily run cap (`DAILY_RUN_CAP`, default 1500).
- Per-run Qloo call budget (120), at most 12 agent-screened names, at most 8 LLM turns, 90 s LLM
  timeout, `maxDuration` 120 s.

## Licences and attribution

- This repository: MIT (see `LICENSE`).
- Data: Qloo Taste AI API under Qloo's API terms. No Qloo data is redistributed.
- Fonts: Geist and Geist Mono (SIL OFL 1.1), Instrument Serif (SIL OFL 1.1), served by
  `next/font`.
- Key dependencies: Next.js (MIT), React (MIT), Zod (MIT), `@anthropic-ai/sdk` (MIT), Tailwind CSS
  (MIT), Vitest (MIT), Playwright (Apache-2.0).
- No third-party images, logos or album art are shown. Namesakes appear as text only.
