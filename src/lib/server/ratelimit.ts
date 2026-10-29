import "server-only";

/**
 * Per-IP token bucket. In-memory, so on serverless it is per-instance (best
 * effort); combined with per-run Qloo call budgets and a global daily cap it
 * bounds abuse and cost. Documented in docs/SECURITY_PRIVACY_LICENSES.md.
 */
const buckets = new Map<string, { tokens: number; updated: number }>();
let day = new Date().toISOString().slice(0, 10);
let dailyRuns = 0;

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "unknown").trim().slice(0, 64);
}

export function take(key: string, capacity: number, refillPerMinute: number): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: capacity, updated: now };
  const refill = ((now - b.updated) / 60_000) * refillPerMinute;
  b.tokens = Math.min(capacity, b.tokens + refill);
  b.updated = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  if (buckets.size > 5000) {
    const oldest = buckets.keys().next().value;
    if (oldest) buckets.delete(oldest);
  }
  return true;
}

export function takeDailyRun(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    dailyRuns = 0;
  }
  const cap = Number(process.env.DAILY_RUN_CAP ?? 1500);
  if (dailyRuns >= cap) return false;
  dailyRuns++;
  return true;
}

export function tooMany(message = "Too many requests. Please wait a minute and try again."): Response {
  return Response.json({ error: message }, { status: 429, headers: { "Retry-After": "30" } });
}
