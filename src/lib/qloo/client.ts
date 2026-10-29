import "server-only";
import { randomUUID } from "node:crypto";
import { TtlCache } from "./cache";
import { QlooError, type QlooCallRecord, type QueryParams } from "./types";
import { validateInsightsParams } from "./validate";

export const HACKATHON_BASE_URL = "https://hackathon.api.qloo.com";

const ALLOWED_PATHS = new Set([
  "/search",
  "/v2/insights",
  "/v2/tags",
  "/v2/tags/types",
  "/v2/analysis/compare",
  "/v2/trending",
  "/v2/audiences",
  "/v2/audiences/types",
  "/entities",
]);

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface QlooClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Hard cap on *uncached* upstream calls made by one client instance (one agent run). */
  callBudget?: number;
  cache?: TtlCache<unknown>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onCall?: (record: QlooCallRecord) => void;
}

// Process-wide private server-side cache (allowed by the hackathon guide; never
// written to the repository). Bounded in size and TTL.
const sharedCache = new TtlCache<unknown>({ maxEntries: 2000, ttlMs: 6 * 60 * 60 * 1000 });

export function serializeParams(params: QueryParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    const s = Array.isArray(value) ? value.join(",") : String(value);
    if (s !== "") out[key] = s;
  }
  return out;
}

function countResults(body: unknown): number {
  const results = (body as { results?: unknown })?.results;
  if (Array.isArray(results)) return results.length;
  if (results && typeof results === "object") {
    for (const v of Object.values(results)) if (Array.isArray(v)) return v.length;
  }
  return 0;
}

function retryAfterMs(res: Response): number | undefined {
  const v = res.headers.get("retry-after");
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export class QlooClient {
  readonly baseUrl: string;
  readonly calls: QlooCallRecord[] = [];
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly callBudget: number;
  private readonly cache: TtlCache<unknown>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onCall?: (record: QlooCallRecord) => void;
  private upstreamCalls = 0;

  constructor(opts: QlooClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.QLOO_API_KEY ?? "";
    if (!apiKey) throw new QlooError("CONFIG", "QLOO_API_KEY is not configured on the server.");
    const baseUrl = (opts.baseUrl ?? process.env.QLOO_API_URL ?? HACKATHON_BASE_URL).replace(/\/+$/, "");
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
      throw new QlooError("CONFIG", "Qloo base URL must be HTTPS.");
    }
    if (url.search || url.username || url.password) {
      throw new QlooError("CONFIG", "Qloo base URL must not contain credentials or a query string.");
    }
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.callBudget = opts.callBudget ?? 40;
    this.cache = opts.cache ?? sharedCache;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onCall = opts.onCall;
  }

  get upstreamCallCount(): number {
    return this.upstreamCalls;
  }

  private record(rec: Omit<QlooCallRecord, "id" | "at">): void {
    const full: QlooCallRecord = { ...rec, id: randomUUID().slice(0, 8), at: new Date().toISOString() };
    this.calls.push(full);
    this.onCall?.(full);
  }

  async get<T = unknown>(path: string, params: QueryParams = {}): Promise<T> {
    if (!ALLOWED_PATHS.has(path)) throw new QlooError("CONFIG", `Path ${path} is not an allowed Qloo endpoint.`);
    const serialized = serializeParams(params);
    if (path === "/v2/insights") {
      try {
        validateInsightsParams(params);
      } catch (err) {
        this.record({
          path,
          params: serialized,
          status: "validation_error",
          ok: false,
          cached: false,
          latencyMs: 0,
          resultCount: 0,
          attempts: 0,
          error: (err as Error).message,
        });
        throw err;
      }
    }

    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(serialized).sort(([a], [b]) => a.localeCompare(b))) {
      url.searchParams.set(k, v);
    }
    const cacheKey = url.pathname + "?" + url.searchParams.toString();
    const hit = this.cache.get(cacheKey);
    if (hit !== undefined) {
      this.record({
        path,
        params: serialized,
        status: 200,
        ok: true,
        cached: true,
        latencyMs: 0,
        resultCount: countResults(hit),
        attempts: 0,
      });
      return hit as T;
    }

    if (this.upstreamCalls >= this.callBudget) {
      throw new QlooError("BUDGET", `Per-run Qloo call budget (${this.callBudget}) exhausted.`);
    }
    this.upstreamCalls++;

    const started = Date.now();
    let attempt = 0;
    let lastError: QlooError | undefined;
    while (attempt < this.maxAttempts) {
      attempt++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "GET",
          headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
          cache: "no-store",
        });
      } catch (err) {
        const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
        lastError = new QlooError(timedOut ? "TIMEOUT" : "NETWORK", timedOut ? "Qloo request timed out." : "Could not reach Qloo.");
        if (attempt < this.maxAttempts) {
          await this.sleep(300 * 2 ** (attempt - 1));
          continue;
        }
        this.record({
          path,
          params: serialized,
          status: timedOut ? "timeout" : "network_error",
          ok: false,
          cached: false,
          latencyMs: Date.now() - started,
          resultCount: 0,
          attempts: attempt,
          error: lastError.message,
        });
        throw lastError;
      }

      if (res.ok) {
        const body = (await res.json()) as T;
        this.cache.set(cacheKey, body);
        this.record({
          path,
          params: serialized,
          status: res.status,
          ok: true,
          cached: false,
          latencyMs: Date.now() - started,
          resultCount: countResults(body),
          attempts: attempt,
        });
        return body;
      }

      const text = (await res.text().catch(() => "")).slice(0, 300);
      lastError = mapError(res.status, text, path, serialized["filter.type"]);
      if (RETRYABLE.has(res.status) && attempt < this.maxAttempts) {
        const wait = Math.min(retryAfterMs(res) ?? 400 * 2 ** (attempt - 1), 5_000);
        await this.sleep(wait);
        continue;
      }
      this.record({
        path,
        params: serialized,
        status: res.status,
        ok: false,
        cached: false,
        latencyMs: Date.now() - started,
        resultCount: 0,
        attempts: attempt,
        error: lastError.message,
      });
      throw lastError;
    }
    throw lastError ?? new QlooError("UPSTREAM", "Qloo request failed.");
  }
}

function mapError(status: number, body: string, path: string, filterType?: string): QlooError {
  // Never echo request headers; the body is truncated and contains no secrets we sent.
  const detail = body.replace(/[\r\n]+/g, " ").trim();
  switch (status) {
    case 401:
      return new QlooError("AUTH", "Qloo rejected the credential (check key and that the hackathon base URL is used).", status);
    case 403:
      return new QlooError(
        "FORBIDDEN_TYPE",
        `Qloo returned 403 for ${path}${filterType ? ` (filter.type=${filterType})` : ""}; the type or endpoint may not be enabled for this key.`,
        status,
      );
    case 404:
      return new QlooError("NOT_FOUND", `Qloo endpoint ${path} not found.`, status);
    case 400:
    case 422:
      return new QlooError("BAD_REQUEST", `Qloo rejected the request: ${detail}`, status);
    case 429:
      return new QlooError("RATE_LIMITED", "Qloo rate limit reached; try again shortly.", status);
    default:
      return new QlooError("UPSTREAM", `Qloo upstream error ${status}.`, status);
  }
}
