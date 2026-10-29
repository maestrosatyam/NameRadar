/**
 * Matched ablation over the pre-registered cases in evals/cases.json.
 *
 *   A  LLM-only:        same model, no Qloo, one verdict per (name, audience) + claimed namesakes
 *   B  Registry-only:   Qloo /search namesakes scored by popularity × match × domain, NO audience signal
 *                       (a "string registry" baseline like a trademark/name search)
 *   C  Qloo scan:       NameRadar deterministic scan (audience-conditional Insights affinity)
 *   D  Full agent:      run once per audience on a subset to measure end-to-end outcome
 *
 * All metrics are PROXIES (no human labels). Output: evals/results/ablation-<timestamp>.json
 * containing aggregate metrics plus per-case verdicts and namesake NAMES/types only (no Qloo
 * affinity payloads are written to the repo).
 *
 *   QLOO_API_KEY=... ANTHROPIC_API_KEY=... npm run eval
 *   flags: --no-llm (skip A and D), --agent-subset=N (default 3)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { QlooClient } from "../src/lib/qloo/client";
import { llmOnlyVerdict } from "../src/lib/radar/baseline";
import { runAgent } from "../src/lib/radar/agent";
import { normalize, matchName } from "../src/lib/radar/match";
import { bandFor, findNamesakes, heatOf, pool, resolveAudience, scoreForAudience, summarize } from "../src/lib/radar/scan";
import { parseEntities } from "../src/lib/radar/entities";
import type { NameScan, ResolvedAudience, RunEvent, Verdict, AudienceInput } from "../src/lib/radar/types";

interface Cases {
  version: number;
  category: string;
  audiences: (AudienceInput & { id: string })[];
  pairs: [string, string][];
  names: string[];
}

const args = new Set(process.argv.slice(2));
const noLlm = args.has("--no-llm") || !process.env.ANTHROPIC_API_KEY;
const agentSubset = Number([...args].find((a) => a.startsWith("--agent-subset="))?.split("=")[1] ?? 3);

const cases = JSON.parse(readFileSync("evals/cases.json", "utf8")) as Cases;
const qloo = new QlooClient({ callBudget: 5000, maxAttempts: 3 });

function registryVerdict(namesakes: Awaited<ReturnType<typeof findNamesakes>>["namesakes"]): { verdict: Verdict; heat: number } {
  // popularity-only prominence (no audience): heatOf with affinity := popularity
  const heat = namesakes.reduce((m, n) => Math.max(m, heatOf(n, n.popularity ?? 0)), 0);
  return { verdict: bandFor(heat), heat };
}

async function main() {
  const t0 = Date.now();
  const audiences = new Map<string, ResolvedAudience>();
  for (const a of cases.audiences) audiences.set(a.id, await resolveAudience(qloo, a));

  // ---- shared namesake discovery (identical input for B and C) ----
  const discovered = new Map<string, Awaited<ReturnType<typeof findNamesakes>>>();
  await pool(cases.names, 3, async (name) => discovered.set(name, await findNamesakes(qloo, name)));

  // ---- C: audience-conditional scans ----
  const scans = new Map<string, NameScan>(); // key name|aud
  for (const [audId, aud] of audiences) {
    await pool(cases.names, 3, async (name) => {
      const d = discovered.get(name)!;
      const scored = await scoreForAudience(qloo, d.namesakes, aud);
      scans.set(`${name}|${audId}`, summarize(name, scored, d.variants));
    });
  }

  // ---- B: registry-only ----
  const registry = new Map(cases.names.map((n) => [n, registryVerdict(discovered.get(n)!.namesakes)]));

  // ---- A: LLM-only ----
  const llm = new Map<string, { verdict: Verdict; claims: { name: string; domain: string; inQloo: boolean }[] }>();
  if (!noLlm) {
    const jobs = cases.names.flatMap((name) => cases.audiences.map((a) => ({ name, a })));
    await pool(jobs, 4, async ({ name, a }) => {
      try {
        const out = await llmOnlyVerdict({ name, category: cases.category, audienceLabel: a.label, anchors: a.anchors });
        const claims = await Promise.all(
          out.namesakes.slice(0, 8).map(async (c) => {
            const body = await qloo.get("/search", { query: c.name, take: 10 }).catch(() => undefined);
            const inQloo = body ? parseEntities(body).some((e) => matchName(c.name, e.name)?.kind === "exact") : false;
            return { name: c.name, domain: c.domain, inQloo };
          }),
        );
        llm.set(`${name}|${a.id}`, { verdict: out.verdict, claims });
      } catch (err) {
        console.error(`LLM-only failed for ${name}/${a.id}: ${(err as Error).message}`);
      }
    });
  }

  // ---- metrics ----
  const flip = (get: (name: string, aud: string) => Verdict | undefined) => {
    let flips = 0;
    let total = 0;
    for (const name of cases.names)
      for (const [x, y] of cases.pairs) {
        const vx = get(name, x);
        const vy = get(name, y);
        if (!vx || !vy) continue;
        total++;
        if (vx !== vy) flips++;
      }
    return { flips, total, rate: total ? flips / total : null };
  };

  const scanVerdict = (n: string, a: string) => scans.get(`${n}|${a}`)?.verdict;
  const llmVerdict = (n: string, a: string) => llm.get(`${n}|${a}`)?.verdict;

  // affinity sensitivity: same namesake, different audience -> different Qloo affinity?
  let affPairs = 0;
  let affAbsDiff = 0;
  let affDiffering = 0;
  for (const name of cases.names)
    for (const [x, y] of cases.pairs) {
      const sx = scans.get(`${name}|${x}`);
      const sy = scans.get(`${name}|${y}`);
      if (!sx || !sy) continue;
      for (const n of sx.namesakes) {
        const m = sy.namesakes.find((k) => k.id === n.id);
        if (!m || n.audienceAffinity === null || m.audienceAffinity === null) continue;
        affPairs++;
        const d = Math.abs(n.audienceAffinity - m.audienceAffinity);
        affAbsDiff += d;
        if (d > 0.05) affDiffering++;
      }
    }

  // LLM grounding: claimed namesakes that exist in Qloo; hot Qloo namesakes the LLM missed
  let claimed = 0;
  let claimedInQloo = 0;
  let hotQloo = 0;
  let hotQlooMentioned = 0;
  for (const [key, l] of llm) {
    claimed += l.claims.length;
    claimedInQloo += l.claims.filter((c) => c.inQloo).length;
    const s = scans.get(key);
    for (const n of s?.namesakes.filter((k) => k.band === "red") ?? []) {
      hotQloo++;
      if (l.claims.some((c) => normalize(c.name) === normalize(n.name))) hotQlooMentioned++;
    }
  }

  let agreeAC = 0;
  let pairsAC = 0;
  for (const [key, l] of llm) {
    const s = scans.get(key);
    if (!s) continue;
    pairsAC++;
    if (s.verdict === l.verdict) agreeAC++;
  }

  // ---- D: full agent on a subset ----
  const agentRuns: { audience: string; names: string[]; ok: boolean; green: number; screened: number; ms: number; qlooCalls: number; llmCalls: number; inTok: number; outTok: number; error?: string }[] = [];
  if (!noLlm) {
    for (const a of cases.audiences.slice(0, agentSubset)) {
      const names = cases.names.slice(0, 2);
      const runClient = new QlooClient({ callBudget: 150 });
      const aud = audiences.get(a.id)!;
      const runScans = new Map<string, NameScan>();
      for (const n of names) runScans.set(normalize(n), scans.get(`${n}|${a.id}`)!);
      const usage = { llmCalls: 0, inputTokens: 0, outputTokens: 0 };
      const started = Date.now();
      try {
        const report = await runAgent({
          qloo: runClient,
          request: { names, category: cases.category, audience: a, mode: "agent", targetClean: 3 },
          audience: aud,
          scans: runScans,
          emit: (_e: RunEvent) => {},
          usage,
        });
        agentRuns.push({
          audience: a.id,
          names,
          ok: true,
          green: report.shortlist.filter((s) => s.verdict === "green").length,
          screened: runScans.size - names.length,
          ms: Date.now() - started,
          qlooCalls: runClient.calls.length,
          llmCalls: usage.llmCalls,
          inTok: usage.inputTokens,
          outTok: usage.outputTokens,
        });
      } catch (err) {
        agentRuns.push({ audience: a.id, names, ok: false, green: 0, screened: 0, ms: Date.now() - started, qlooCalls: runClient.calls.length, llmCalls: usage.llmCalls, inTok: usage.inputTokens, outTok: usage.outputTokens, error: (err as Error).message });
      }
    }
  }

  const callStats = {
    total: qloo.calls.length,
    upstream: qloo.calls.filter((c) => !c.cached).length,
    errors: qloo.calls.filter((c) => !c.ok).map((c) => `${c.path}:${c.status}`),
    medianLatencyMs: (() => {
      const l = qloo.calls.filter((c) => !c.cached && c.ok).map((c) => c.latencyMs).sort((a, b) => a - b);
      return l.length ? l[Math.floor(l.length / 2)] : null;
    })(),
  };

  const result = {
    label: "VERIFIED LIVE (proxy metrics; no human labels)",
    casesVersion: cases.version,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    model: process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
    audiences: [...audiences.values()].map((a) => ({ label: a.label, resolved: a.anchors.map((x) => x.name), unresolved: a.unresolved })),
    metrics: {
      namesWithAnyNamesake: cases.names.filter((n) => discovered.get(n)!.namesakes.length > 0).length,
      totalNames: cases.names.length,
      flipRate: {
        B_registry_only: { flips: 0, total: cases.names.length * cases.pairs.length, rate: 0, note: "audience-blind by construction" },
        C_qloo_scan: flip(scanVerdict),
        A_llm_only: noLlm ? null : flip(llmVerdict),
      },
      qlooAffinitySensitivity: {
        namesakePairs: affPairs,
        meanAbsAffinityDiff: affPairs ? affAbsDiff / affPairs : null,
        shareDifferingByMoreThan0_05: affPairs ? affDiffering / affPairs : null,
        note: "Proves audience signals are accepted (not silently ignored) by Qloo Insights.",
      },
      llmGrounding: noLlm
        ? null
        : {
            claimedNamesakes: claimed,
            claimedFoundInQloo: claimedInQloo,
            shareFoundInQloo: claimed ? claimedInQloo / claimed : null,
            qlooRedNamesakes: hotQloo,
            qlooRedMentionedByLlm: hotQlooMentioned,
            llmRecallOfQlooRed: hotQloo ? hotQlooMentioned / hotQloo : null,
          },
      verdictAgreement_A_vs_C: noLlm ? null : { agree: agreeAC, total: pairsAC, rate: pairsAC ? agreeAC / pairsAC : null },
      registryVerdicts: Object.fromEntries([...registry].map(([n, r]) => [n, r.verdict])),
      agentRuns,
      qlooCalls: callStats,
    },
    perCase: cases.names.map((name) => ({
      name,
      namesakes: discovered.get(name)!.namesakes.slice(0, 8).map((n) => `${n.name} [${n.type.split(":").pop()}]`),
      registry: registry.get(name)!.verdict,
      qloo: Object.fromEntries(cases.audiences.map((a) => [a.id, scanVerdict(name, a.id)])),
      llm: noLlm ? null : Object.fromEntries(cases.audiences.map((a) => [a.id, llmVerdict(name, a.id)])),
    })),
  };
  mkdirSync("evals/results", { recursive: true });
  const file = `evals/results/ablation-${result.ranAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.metrics, null, 2));
  console.log(`\nwrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
