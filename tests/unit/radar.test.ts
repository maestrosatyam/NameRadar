import { describe, expect, it, vi } from "vitest";
import { QlooClient } from "@/lib/qloo/client";
import { TtlCache } from "@/lib/qloo/cache";
import { parseEntities, toInsightsType } from "@/lib/radar/entities";
import { matchName, normalize } from "@/lib/radar/match";
import { bandFor, domainWeightFor, HEAT_RED, heatOf, resolveAudience, scanName, spellingVariants } from "@/lib/radar/scan";
import { clearCalibrationMemo, estimateRank, MAX_RANK, salienceFromRank } from "@/lib/radar/calibrate";
import { heuristicVariants } from "@/lib/radar/agent";
import type { ResolvedAudience } from "@/lib/radar/types";

describe("name matching", () => {
  it("normalises case, accents, punctuation and ampersands", () => {
    expect(normalize("  Beyoncé & Co.!! ")).toBe("beyonce and co");
  });
  it.each([
    ["Tidal", "TIDAL", "exact"],
    ["Red Bull", "Redbull", "exact"],
    ["Tidal", "The Tidal", "exact"],
    ["Tidal", "Tidal Wave", "contains_word"],
    ["Sambucks", "Starbucks", "near_spelling"],
    ["Bloom", "Bloomberg", "inside_word"],
  ])("%s vs %s -> %s", (c, e, kind) => {
    expect(matchName(c, e)?.kind).toBe(kind);
  });
  it("does not treat unrelated search hits as namesakes", () => {
    expect(matchName("Tidal", "Ocean Spray")).toBeNull();
    expect(matchName("Ion", "Lion King")).toBeNull();
  });
  it("whole-word containment beats substring noise", () => {
    expect(matchName("Art", "Party Rock")).toBeNull();
  });
});

describe("type mapping between /search and Insights vocabularies", () => {
  it("maps search-only types onto insights types", () => {
    expect(toInsightsType(["urn:entity:actor"])).toBe("urn:entity:person");
    expect(toInsightsType(["urn:entity:place:restaurant"])).toBe("urn:entity:place");
    expect(toInsightsType(["urn:entity:album"])).toBeUndefined();
  });
  it("parses entities defensively and skips malformed rows", () => {
    const parsed = parseEntities({
      results: [
        { entity_id: "1", name: "A", types: ["urn:entity:brand"], popularity: 0.5 },
        { name: "missing id" },
        { entity_id: "2", name: "Album", types: ["urn:entity:album"] },
      ],
    });
    expect(parsed.map((p) => p.name)).toEqual(["A"]);
  });
});

describe("heat scoring", () => {
  const base = { similarity: 1, type: "urn:entity:brand", popularity: 0.97 };
  it("is audience-conditional: same namesake, different salience, different band", () => {
    expect(bandFor(heatOf(base, 0.9))).toBe("red");
    // a globally famous namesake the audience doesn't care about is still "crowded", not clear
    expect(bandFor(heatOf(base, 0))).toBe("amber");
    // a less famous namesake flips all the way from red to green
    const niche = { ...base, popularity: 0.75 };
    expect(bandFor(heatOf(niche, 0.9))).toBe("red");
    expect(bandFor(heatOf(niche, 0))).toBe("green");
  });
  it("down-weights loose matches and distant domains", () => {
    expect(heatOf({ ...base, similarity: 0.4 }, 0.9)).toBeLessThan(heatOf(base, 0.9));
    expect(heatOf({ ...base, type: "urn:entity:destination" }, 0.9)).toBeLessThan(heatOf(base, 0.9));
  });
  it("treats a missing audience rank as unknown, not as hot", () => {
    expect(heatOf(base, null)).toBeLessThan(HEAT_RED);
  });
  it("clamps out-of-range inputs", () => {
    expect(heatOf({ ...base, popularity: 7 }, 3)).toBeLessThanOrEqual(1);
  });
  it("halves local places unless a launch region is set", () => {
    expect(domainWeightFor("urn:entity:place", {})).toBeLessThan(domainWeightFor("urn:entity:place", { region: "Austin" }));
    expect(domainWeightFor("urn:entity:brand", {})).toBe(1);
  });
});

describe("rank calibration", () => {
  // shape measured live on 2026-10-30 (brands, hip-hop audience)
  const cal = {
    type: "urn:entity:brand",
    points: [
      { rank: 1, affinity: 0.98 },
      { rank: 50, affinity: 0.905 },
      { rank: 200, affinity: 0.864 },
      { rank: 1000, affinity: 0.789 },
      { rank: 5000, affinity: 0.686 },
    ],
  };
  it("interpolates rank in log space between samples", () => {
    const r = estimateRank(0.83, cal)!;
    expect(r.beyondSample).toBe(false);
    expect(r.rank).toBeGreaterThan(200);
    expect(r.rank).toBeLessThan(1000);
  });
  it("returns rank 1 at or above the top and extrapolates (capped) below the deepest sample", () => {
    expect(estimateRank(0.99, cal)!.rank).toBe(1);
    const deep = estimateRank(0.5, cal)!;
    expect(deep.beyondSample).toBe(true);
    expect(deep.rank).toBeLessThanOrEqual(MAX_RANK);
  });
  it("is monotonic: higher affinity never yields a worse rank", () => {
    let prev = 0;
    for (let a = 0.99; a > 0.6; a -= 0.01) {
      const r = estimateRank(a, cal)!.rank;
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });
  it("refuses to estimate from a degenerate calibration", () => {
    expect(estimateRank(0.8, { type: "x", points: [{ rank: 1, affinity: 0.9 }] })).toBeNull();
  });
  it("maps rank to salience on a log scale", () => {
    expect(salienceFromRank(10)).toBe(1);
    expect(salienceFromRank(5000)).toBe(0);
    expect(salienceFromRank(400)).toBeGreaterThan(salienceFromRank(2000));
  });
});

describe("variants", () => {
  it("adds squashed and article-free search variants", () => {
    expect(spellingVariants("The Blue Note")).toEqual(expect.arrayContaining(["The Blue Note", "bluenote", "Blue Note"]));
  });
  it("heuristic planner never re-proposes a taken name", () => {
    const v = heuristicVariants("Tidal", new Set(["tidaly"]));
    expect(v).not.toContain("Tidaly");
    expect(v.length).toBeGreaterThan(0);
  });
});

/* ---------------- scan pipeline against an injected MOCK fetch ---------------- */

const A1 = "11111111-1111-1111-1111-111111111111";
const N1 = "22222222-2222-2222-2222-222222222222";
const N2 = "33333333-3333-3333-3333-333333333333";

function mockQloo(affinityFor: (signals: string) => number) {
  return vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const p = url.searchParams;
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname === "/search") {
      const q = p.get("query");
      if (q === "Fans Love This") return json({ results: [{ entity_id: A1, name: "Fans Love This", types: ["urn:entity:artist"], popularity: 0.8 }] });
      if (q === "Tidal")
        return json({
          results: [
            { entity_id: N1, name: "TIDAL", types: ["urn:entity:brand"], popularity: 0.9 },
            { entity_id: N2, name: "Tidal Wave", types: ["urn:entity:artist"], popularity: 0.4 },
            { entity_id: "44444444-4444-4444-4444-444444444444", name: "Ocean", types: ["urn:entity:brand"], popularity: 0.9 },
          ],
        });
      return json({ results: [] });
    }
    if (url.pathname === "/v2/insights") {
      const ids = (p.get("filter.results.entities") ?? "").split(",").filter(Boolean);
      const sig = p.get("signal.interests.entities") ?? "";
      if (!ids.length) {
        const page = Number(p.get("page") ?? 1);
        return json({
          results: {
            entities: Array.from({ length: 50 }, (_, i) => ({
              entity_id: `cal-${page}-${i}`,
              name: "cal",
              query: { affinity: 0.98 - 0.07 * Math.log10((page - 1) * 50 + i + 1) },
            })),
          },
        });
      }
      return json({ results: { entities: ids.map((id) => ({ entity_id: id, name: id, query: { affinity: affinityFor(sig) } })) } });
    }
    return new Response("{}", { status: 404 });
  });
}

function client(fetchImpl: ReturnType<typeof mockQloo>) {
  return new QlooClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch, cache: new TtlCache({ maxEntries: 100, ttlMs: 1e6 }) });
}

describe("scan pipeline (MOCK Qloo)", () => {
  it("resolves the audience, finds true namesakes only, and scores them for the audience", async () => {
    clearCalibrationMemo();
  const f = mockQloo(() => 0.97);
    const c = client(f);
    const audience = await resolveAudience(c, { label: "Fans", anchors: ["Fans Love This", "Unknown Thing"] });
    expect(audience.anchors.map((a) => a.id)).toEqual([A1]);
    expect(audience.unresolved).toEqual(["Unknown Thing"]);
    const scan = await scanName(c, "Tidal", audience);
    expect(scan.namesakes.map((n) => n.name)).toEqual(["TIDAL", "Tidal Wave"]); // "Ocean" filtered out
    expect(scan.verdict).toBe("red");
    // the audience signal and the shortlist are both sent to Insights
    const insightCalls = c.calls.filter((x) => x.path === "/v2/insights");
    expect(insightCalls.every((x) => x.params["signal.interests.entities"] === A1)).toBe(true);
    expect(insightCalls.some((x) => x.params["filter.results.entities"]?.includes(N1))).toBe(true);
  });

  it("flips verdict when the audience changes (the core Qloo-dependent behaviour)", async () => {
    clearCalibrationMemo();
    const f = mockQloo((sig) => (sig === A1 ? 0.97 : 0.6));
    const c = client(f);
    const fans = await resolveAudience(c, { label: "Fans", anchors: ["Fans Love This"] });
    const others: ResolvedAudience = { ...fans, label: "Others", anchors: [{ ...fans.anchors[0], id: "55555555-5555-5555-5555-555555555555" }] };
    const a = await scanName(c, "Tidal", fans);
    const b = await scanName(c, "Tidal", others);
    expect(a.verdict).toBe("red");
    expect(b.verdict).not.toBe("red");
    expect(b.heat).toBeLessThan(a.heat / 2);
  });

  it("degrades gracefully when Insights fails: namesakes kept, affinity null, noted", async () => {
    const f = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/search")
        return new Response(JSON.stringify({ results: [{ entity_id: N1, name: "Tidal", types: ["urn:entity:brand"], popularity: 0.9 }] }));
      return new Response("{}", { status: 500 });
    });
    const c = new QlooClient({ apiKey: "k", fetchImpl: f as unknown as typeof fetch, sleep: async () => {}, cache: new TtlCache({ maxEntries: 10, ttlMs: 1e6 }) });
    const scan = await scanName(c, "Tidal", { label: "x", anchors: [{ id: A1, name: "a", type: "urn:entity:artist", rawTypes: [] }], unresolved: [] });
    expect(scan.namesakes[0].audienceAffinity).toBeNull();
    expect(scan.notes.join(" ")).toMatch(/no audience rank/);
  });
});
