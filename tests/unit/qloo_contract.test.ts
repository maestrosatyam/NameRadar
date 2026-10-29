/**
 * Provider-contract tests for the Qloo adapter. These use an injected fetch
 * (MOCK) to assert exactly what we send to Qloo and how we react to each class
 * of response. Live conformance is checked separately by scripts/smoke_qloo.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { QlooClient, serializeParams } from "@/lib/qloo/client";
import { TtlCache } from "@/lib/qloo/cache";
import { QlooError } from "@/lib/qloo/types";
import { validateInsightsParams } from "@/lib/qloo/validate";

const ID = "B4C7663F-BD6E-F3DA-498A-185C07A39C5E";
const ID2 = "41C668DB-756F-399F-C861-4A029241163B";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function makeClient(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof QlooClient>[0]> = {}) {
  return new QlooClient({
    apiKey: "test-key",
    fetchImpl,
    cache: new TtlCache({ maxEntries: 50, ttlMs: 60_000 }),
    sleep: async () => {},
    ...extra,
  });
}

describe("request shape", () => {
  it("uses the hackathon host, GET, X-Api-Key header and comma-joined arrays", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: { entities: [] } }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.get("/v2/insights", {
      "filter.type": "urn:entity:brand",
      "signal.interests.entities": [ID, ID2],
      take: 5,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe("https://hackathon.api.qloo.com");
    expect(url.pathname).toBe("/v2/insights");
    expect(url.searchParams.get("signal.interests.entities")).toBe(`${ID},${ID2}`);
    expect(url.searchParams.has("api_key")).toBe(false);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe("test-key");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("refuses to construct without a key, and refuses non-https hosts", () => {
    const saved = process.env.QLOO_API_KEY;
    delete process.env.QLOO_API_KEY;
    expect(() => new QlooClient({ apiKey: "" })).toThrow(QlooError);
    process.env.QLOO_API_KEY = saved;
    expect(() => new QlooClient({ apiKey: "k", baseUrl: "http://evil.example.com" })).toThrow(/HTTPS/);
    expect(() => new QlooClient({ apiKey: "k", baseUrl: "https://hackathon.api.qloo.com/?x=1" })).toThrow();
  });

  it("only calls documented endpoints", async () => {
    const client = makeClient(vi.fn() as unknown as typeof fetch);
    await expect(client.get("/recommendations", {})).rejects.toThrow(/not an allowed/);
    await expect(client.get("/v2/insights/search", {})).rejects.toThrow(/not an allowed/);
  });

  it("drops empty params when serialising", () => {
    expect(serializeParams({ a: undefined, b: "", c: [], d: ["x"], e: 0 })).toEqual({ d: "x", e: "0" });
  });
});

describe("validation of silently-ignored parameter combinations", () => {
  it("rejects undocumented filter.type values", () => {
    expect(() => validateInsightsParams({ "filter.type": "urn:entity:music", "signal.interests.entities": ID })).toThrow(/not a documented/);
    expect(() => validateInsightsParams({ "filter.type": "urn:entity:restaurant", "signal.interests.entities": ID })).toThrow();
  });

  it("rejects location filters on non-geo types (Qloo would silently ignore them)", () => {
    expect(() =>
      validateInsightsParams({ "filter.type": "urn:entity:movie", "signal.interests.entities": ID, "filter.location.query": "Austin" }),
    ).toThrow(/silently ignored/);
    expect(() =>
      validateInsightsParams({ "filter.type": "urn:entity:place", "signal.interests.entities": ID, "filter.location.query": "Austin" }),
    ).not.toThrow();
  });

  it("rejects place-only params on brands", () => {
    expect(() => validateInsightsParams({ "filter.type": "urn:entity:brand", "signal.interests.entities": ID, "bias.quality": "high" })).toThrow();
  });

  it("requires a signal so results are taste-grounded, not generic popularity", () => {
    expect(() => validateInsightsParams({ "filter.type": "urn:entity:brand" })).toThrow(/no signal/);
  });

  it("requires resolved ids and tag URNs, not raw names", () => {
    expect(() => validateInsightsParams({ "filter.type": "urn:entity:brand", "signal.interests.entities": "Nike" })).toThrow(/resolve names/);
    expect(() => validateInsightsParams({ "filter.type": "urn:entity:brand", "signal.interests.tags": "jazz" })).toThrow(/tag URN/);
  });

  it("validates demographic buckets and take bounds from the parameter reference", () => {
    expect(() =>
      validateInsightsParams({ "filter.type": "urn:entity:brand", "signal.interests.entities": ID, "signal.demographics.age": "25_to_29,55_and_older" }),
    ).not.toThrow();
    expect(() => validateInsightsParams({ "filter.type": "urn:entity:brand", "signal.interests.entities": ID, "signal.demographics.age": "18_to_24" })).toThrow();
    expect(() => validateInsightsParams({ "filter.type": "urn:entity:brand", "signal.interests.entities": ID, take: 51 })).toThrow();
  });

  it("special insight types accept their own params only", () => {
    expect(() => validateInsightsParams({ "filter.type": "urn:tag", "signal.interests.entities": ID })).not.toThrow();
    expect(() => validateInsightsParams({ "filter.type": "urn:tag" })).toThrow();
    expect(() =>
      validateInsightsParams({ "filter.type": "urn:heatmap", "signal.interests.entities": ID, "filter.location.query": "United States" }),
    ).not.toThrow();
    expect(() => validateInsightsParams({ "filter.type": "urn:demographics", "signal.interests.entities": ID, take: 5 })).toThrow();
  });

  it("logs validation failures in the provenance trail without calling Qloo", async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.get("/v2/insights", { "filter.type": "urn:entity:brand" })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.calls[0].status).toBe("validation_error");
  });
});

describe("error handling, retries and budgets", () => {
  it("retries 429 honouring Retry-After, then succeeds", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async () => (n++ === 0 ? jsonResponse({}, 429, { "retry-after": "2" }) : jsonResponse({ results: [] })));
    const client = makeClient(fetchImpl as unknown as typeof fetch, { sleep: async (ms) => void sleeps.push(ms) });
    await client.get("/search", { query: "x" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps[0]).toBe(2000);
    expect(client.calls.at(-1)?.attempts).toBe(2);
  });

  it("caps Retry-After so a hostile header cannot stall a run", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async () => (n++ === 0 ? jsonResponse({}, 503, { "retry-after": "9999" }) : jsonResponse({ results: [] })));
    const client = makeClient(fetchImpl as unknown as typeof fetch, { sleep: async (ms) => void sleeps.push(ms) });
    await client.get("/search", { query: "x" });
    expect(sleeps[0]).toBeLessThanOrEqual(5000);
  });

  it("gives up after maxAttempts on persistent 429 with a RATE_LIMITED error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429));
    const client = makeClient(fetchImpl as unknown as typeof fetch, { maxAttempts: 3 });
    await expect(client.get("/search", { query: "x" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry 401/403 and maps them to actionable codes", async () => {
    const c401 = makeClient(vi.fn(async () => jsonResponse({}, 401)) as unknown as typeof fetch);
    await expect(c401.get("/search", { query: "x" })).rejects.toMatchObject({ code: "AUTH" });
    const f403 = vi.fn(async () => jsonResponse({}, 403));
    const c403 = makeClient(f403 as unknown as typeof fetch);
    await expect(c403.get("/v2/insights", { "filter.type": "urn:entity:podcast", "signal.interests.entities": ID })).rejects.toMatchObject({
      code: "FORBIDDEN_TYPE",
    });
    expect(f403).toHaveBeenCalledTimes(1);
  });

  it("maps network failures and timeouts", async () => {
    const err = Object.assign(new Error("t"), { name: "TimeoutError" });
    const client = makeClient(vi.fn(async () => Promise.reject(err)) as unknown as typeof fetch, { maxAttempts: 2 });
    await expect(client.get("/search", { query: "x" })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(client.calls.at(-1)?.status).toBe("timeout");
  });

  it("never leaks the API key into the call log or error messages", async () => {
    const client = makeClient(vi.fn(async () => jsonResponse({ message: "bad" }, 400)) as unknown as typeof fetch, { apiKey: "SECRET-KEY-123" });
    await expect(client.get("/search", { query: "x" })).rejects.toThrow();
    expect(JSON.stringify(client.calls)).not.toContain("SECRET-KEY-123");
  });

  it("serves repeated identical requests from the private cache", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [{ entity_id: ID, name: "A" }] }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.get("/search", { query: "x", take: 3 });
    await client.get("/search", { take: 3, query: "x" }); // param order must not matter
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.calls.map((c) => c.cached)).toEqual([false, true]);
  });

  it("enforces a per-run upstream call budget", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
    const client = makeClient(fetchImpl as unknown as typeof fetch, { callBudget: 2 });
    await client.get("/search", { query: "a" });
    await client.get("/search", { query: "b" });
    await expect(client.get("/search", { query: "c" })).rejects.toMatchObject({ code: "BUDGET" });
  });
});
