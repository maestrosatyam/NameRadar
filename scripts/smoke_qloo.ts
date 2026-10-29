/**
 * Live Qloo conformance probe. Run with a real key:
 *   QLOO_API_KEY=... npm run smoke:qloo
 *
 * Writes evidence/qloo_live_api_probe.json containing ONLY sanitized metadata
 * (endpoint, non-secret params, HTTP status, latency, result count, response
 * field names). Qloo response data itself is never written to the repository.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { QlooClient } from "../src/lib/qloo/client";
import type { QueryParams } from "../src/lib/qloo/types";

interface ProbeResult {
  name: string;
  path: string;
  params: Record<string, string>;
  status: number | string;
  ok: boolean;
  latencyMs: number;
  resultCount: number;
  resultKeys?: string[];
  firstResultFields?: string[];
  note?: string;
  error?: string;
}

const client = new QlooClient({ callBudget: 60, maxAttempts: 2 });
const out: ProbeResult[] = [];

function shape(body: unknown): { keys: string[]; first: string[] } {
  const results = (body as { results?: unknown })?.results;
  if (Array.isArray(results)) {
    return { keys: ["<array>"], first: results[0] ? Object.keys(results[0] as object) : [] };
  }
  if (results && typeof results === "object") {
    const keys = Object.keys(results);
    for (const v of Object.values(results)) {
      if (Array.isArray(v) && v[0]) return { keys, first: Object.keys(v[0] as object) };
    }
    return { keys, first: [] };
  }
  return { keys: [], first: [] };
}

async function probe(name: string, path: string, params: QueryParams, note?: string): Promise<unknown> {
  try {
    const body = await client.get(path, params);
    const rec = client.calls[client.calls.length - 1];
    const s = shape(body);
    out.push({
      name,
      path,
      params: rec.params,
      status: rec.status,
      ok: true,
      latencyMs: rec.latencyMs,
      resultCount: rec.resultCount,
      resultKeys: s.keys,
      firstResultFields: s.first,
      note,
    });
    console.log(`OK   ${name}: ${rec.status} ${rec.resultCount} results ${rec.latencyMs}ms`);
    return body;
  } catch (err) {
    const rec = client.calls[client.calls.length - 1];
    out.push({
      name,
      path,
      params: rec?.params ?? {},
      status: rec?.status ?? "error",
      ok: false,
      latencyMs: rec?.latencyMs ?? 0,
      resultCount: 0,
      note,
      error: (err as Error).message,
    });
    console.log(`FAIL ${name}: ${(err as Error).message}`);
    return undefined;
  }
}

function firstId(body: unknown, key = "results"): string | undefined {
  const r = (body as Record<string, unknown>)?.[key];
  const arr = Array.isArray(r) ? r : r && typeof r === "object" ? Object.values(r).find(Array.isArray) : undefined;
  return (arr?.[0] as { entity_id?: string } | undefined)?.entity_id;
}

async function main() {
  const actName = process.argv[2] ?? "Phoebe Bridgers";
  const search = await probe("search artist", "/search", { query: actName, types: "urn:entity:artist", take: 3 });
  const artistId = firstId(search);
  await probe("search person (comedian)", "/search", { query: "John Mulaney", types: "urn:entity:person", take: 3 });
  await probe("search destination", "/search", { query: "Austin", types: "urn:entity:destination", take: 3 });
  const tags = await probe("tags semantic search", "/v2/tags", {
    "filter.query": "music venue",
    "feature.semantic_search": true,
    take: 10,
  });
  const tagId = (((tags as { results?: { tags?: { id?: string }[] } })?.results?.tags ?? [])[0] ?? {}).id;

  if (!artistId) {
    console.log("No artist id resolved; stopping dependent probes.");
  } else {
    const sig = { "signal.interests.entities": artistId };
    await probe("insights artist (similar acts)", "/v2/insights", { "filter.type": "urn:entity:artist", ...sig, take: 10 });
    await probe("insights artist + signal.location.query", "/v2/insights", {
      "filter.type": "urn:entity:artist",
      ...sig,
      "signal.location.query": "Austin",
      take: 10,
    }, "local openers: does location signal change ranking?");
    await probe("insights destination", "/v2/insights", { "filter.type": "urn:entity:destination", ...sig, take: 10 });
    await probe("insights brand", "/v2/insights", { "filter.type": "urn:entity:brand", ...sig, take: 10 });
    await probe("insights podcast", "/v2/insights", { "filter.type": "urn:entity:podcast", ...sig, take: 5 });
    await probe("insights place in city", "/v2/insights", {
      "filter.type": "urn:entity:place",
      ...sig,
      "filter.location.query": "Austin",
      take: 10,
    });
    if (tagId) {
      await probe("insights place in city + venue tag", "/v2/insights", {
        "filter.type": "urn:entity:place",
        ...sig,
        "filter.location.query": "Austin",
        "filter.tags": tagId,
        take: 10,
      });
    }
    await probe("heatmap default", "/v2/insights", {
      "filter.type": "urn:heatmap",
      ...sig,
      "filter.location.query": "United States",
      take: 20,
    });
    for (const boundary of ["city", "urn:city", "neighborhood"]) {
      await probe(`heatmap boundary=${boundary}`, "/v2/insights", {
        "filter.type": "urn:heatmap",
        ...sig,
        "filter.location.query": "United States",
        "output.heatmap.boundary": boundary,
        take: 20,
      });
    }
    await probe("taste analysis urn:tag", "/v2/insights", { "filter.type": "urn:tag", ...sig, take: 10 });
    await probe("demographics", "/v2/insights", { "filter.type": "urn:demographics", ...sig });
    await probe("explainability", "/v2/insights", {
      "filter.type": "urn:entity:artist",
      ...sig,
      "feature.explainability": true,
      take: 3,
    });
  }
  for (const t of ["urn:entity:video_game", "urn:entity:videogame"]) {
    // Raw call bypassing our validator to settle the docs/harness discrepancy.
    try {
      const url = new URL(client.baseUrl + "/v2/insights");
      url.searchParams.set("filter.type", t);
      url.searchParams.set("signal.interests.tags", "urn:tag:genre:media:action");
      url.searchParams.set("take", "1");
      const started = Date.now();
      const res = await fetch(url, { headers: { "X-Api-Key": process.env.QLOO_API_KEY ?? "" } });
      out.push({
        name: `type check ${t}`,
        path: "/v2/insights",
        params: Object.fromEntries(url.searchParams),
        status: res.status,
        ok: res.ok,
        latencyMs: Date.now() - started,
        resultCount: 0,
        note: "settles urn:entity:video_game vs urn:entity:videogame",
      });
      console.log(`TYPE ${t}: ${res.status}`);
    } catch (err) {
      console.log(`TYPE ${t}: ${(err as Error).message}`);
    }
  }

  mkdirSync("evidence", { recursive: true });
  writeFileSync(
    "evidence/qloo_live_api_probe.json",
    JSON.stringify(
      {
        label: "VERIFIED LIVE (sanitized: metadata only, no Qloo response data)",
        baseUrl: client.baseUrl,
        ranAt: new Date().toISOString(),
        probes: out,
      },
      null,
      2,
    ),
  );
  console.log(`\n${out.filter((p) => p.ok).length}/${out.length} probes OK -> evidence/qloo_live_api_probe.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
