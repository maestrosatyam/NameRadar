import type { QlooClient } from "../qloo/client";
import type { QueryParams } from "../qloo/types";
import { resultsArray } from "./entities";

/**
 * Qloo `query.affinity` is a compressed score: for one audience, the top 50
 * brands sit around 0.89–0.98 and rank 5,000 around 0.70. Raw thresholds on it
 * are therefore meaningless. Instead we sample the audience's own ranking for a
 * domain (live, via Insights pagination) and convert any affinity into an
 * estimated rank within that audience's taste for that domain.
 *
 * Verified live on 2026-10-30 (see docs/QLOO_API_CONFORMANCE.md §Calibration).
 */

export interface CalibrationPoint {
  rank: number;
  affinity: number;
}

export interface Calibration {
  type: string;
  points: CalibrationPoint[]; // ascending rank, descending affinity
}

/** Pages (take=50) sampled per domain. Deep pages are skipped where Qloo stops returning results (~1,000). */
const PAGES_BY_TYPE: Record<string, number[]> = {
  "urn:entity:brand": [1, 4, 20, 100],
  "urn:entity:place": [1, 4, 20, 100],
};
const DEFAULT_PAGES = [1, 4, 20];

const memo = new Map<string, Promise<Calibration>>();

export function calibrationKey(type: string, signals: QueryParams): string {
  return (
    type +
    "|" +
    Object.entries(signals)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`)
      .sort()
      .join("&")
  );
}

export function calibrate(client: QlooClient, type: string, signals: QueryParams): Promise<Calibration> {
  const key = calibrationKey(type, signals);
  let p = memo.get(key);
  if (!p) {
    p = (async () => {
      const pages = PAGES_BY_TYPE[type] ?? DEFAULT_PAGES;
      const results = await Promise.all(
        pages.map((page) =>
          client
            .get("/v2/insights", { "filter.type": type, ...signals, take: 50, page })
            .then((body) => ({ page, rows: resultsArray(body, "entities") as { query?: { affinity?: number } }[] }))
            .catch(() => ({ page, rows: [] as { query?: { affinity?: number } }[] })),
        ),
      );
      const points: CalibrationPoint[] = [];
      for (const { page, rows } of results) {
        if (!rows.length) continue;
        const first = rows[0]?.query?.affinity;
        const last = rows[rows.length - 1]?.query?.affinity;
        if (page === 1 && typeof first === "number") points.push({ rank: 1, affinity: first });
        if (typeof last === "number") points.push({ rank: (page - 1) * 50 + rows.length, affinity: last });
      }
      points.sort((a, b) => a.rank - b.rank);
      // enforce monotonic (non-increasing) affinity
      for (let i = 1; i < points.length; i++) {
        if (points[i].affinity > points[i - 1].affinity) points[i].affinity = points[i - 1].affinity;
      }
      return { type, points };
    })();
    memo.set(key, p);
    if (memo.size > 500) memo.delete(memo.keys().next().value as string);
    // a failed/empty calibration should not be cached forever
    p.then((c) => c.points.length < 2 && memo.delete(key)).catch(() => memo.delete(key));
  }
  return p;
}

export const MAX_RANK = 20_000;

/** Estimated rank of an affinity within the calibrated distribution (log-rank interpolation). */
export function estimateRank(affinity: number, cal: Calibration): { rank: number; beyondSample: boolean } | null {
  const pts = cal.points;
  if (pts.length < 2) return null;
  if (affinity >= pts[0].affinity) return { rank: 1, beyondSample: false };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (affinity >= b.affinity) {
      const span = a.affinity - b.affinity;
      const t = span <= 0 ? 0 : (a.affinity - affinity) / span;
      const logRank = Math.log10(a.rank) + t * (Math.log10(b.rank) - Math.log10(a.rank));
      return { rank: Math.round(10 ** logRank), beyondSample: false };
    }
  }
  // below the deepest sample: extrapolate with the last segment's slope (in log-rank space)
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  const slope = (Math.log10(b.rank) - Math.log10(a.rank)) / Math.max(1e-6, a.affinity - b.affinity);
  const logRank = Math.log10(b.rank) + (b.affinity - affinity) * slope;
  return { rank: Math.min(MAX_RANK, Math.round(10 ** logRank)), beyondSample: true };
}

/** 0..1 salience from rank: top 25 → 1, rank 5,000 or worse → 0 (log scale). */
export function salienceFromRank(rank: number): number {
  const s = 1 - Math.log10(Math.max(1, rank) / 25) / Math.log10(5000 / 25);
  return Number(Math.max(0, Math.min(1, s)).toFixed(4));
}

export function clearCalibrationMemo(): void {
  memo.clear();
}
