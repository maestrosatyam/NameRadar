import { z } from "zod";

export const AGE_BUCKET_VALUES = [
  "24_and_younger",
  "25_to_29",
  "30_to_34",
  "35_to_44",
  "45_to_54",
  "55_and_older",
] as const;

/** What the user tells us about who they are selling to. */
export const AudienceInputSchema = z.object({
  label: z.string().trim().min(1).max(60),
  /** 1-4 things the target customers already love ("shelf neighbours"): brands, artists, shows... */
  anchors: z.array(z.string().trim().min(1).max(80)).min(1).max(4),
  ageBuckets: z.array(z.enum(AGE_BUCKET_VALUES)).max(3).optional(),
  region: z.string().trim().min(2).max(60).optional(),
});
export type AudienceInput = z.infer<typeof AudienceInputSchema>;

export const RunRequestSchema = z.object({
  names: z.array(z.string().trim().min(1).max(40)).min(1).max(5),
  category: z.string().trim().min(2).max(120),
  brief: z.string().trim().max(400).optional(),
  audience: AudienceInputSchema,
  /** "agent": full LLM agent loop with auto-fix. "scan": deterministic scan only. */
  mode: z.enum(["agent", "scan"]).default("agent"),
  /** Number of clean names the agent should try to deliver. */
  targetClean: z.number().int().min(1).max(5).default(3),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;

export interface ResolvedEntity {
  id: string;
  name: string;
  type: string; // Insights filter.type URN
  rawTypes: string[];
  popularity?: number;
  disambiguation?: string;
  imageUrl?: string;
}

export interface ResolvedAudience {
  label: string;
  anchors: ResolvedEntity[];
  unresolved: string[];
  ageBuckets?: string[];
  region?: string;
}

export type MatchKind = "exact" | "contains_word" | "inside_word" | "near_spelling";

export interface Namesake extends ResolvedEntity {
  matchKind: MatchKind;
  similarity: number; // 0..1
}

export interface ScoredNamesake extends Namesake {
  /** Qloo query.affinity of this namesake for the target audience (null = Qloo returned no score). */
  audienceAffinity: number | null;
  /** Estimated rank of this namesake within the audience's own Qloo ranking for its domain. */
  audienceRank: number | null;
  /** True when the rank was extrapolated below the deepest calibration sample. */
  rankBeyondSample: boolean;
  /** 0..1 from audienceRank (top 25 → 1, 5,000+ → 0). */
  salience: number | null;
  /** Domain proximity between the user's category and the namesake's domain (0..1). */
  proximity: number;
  heat: number; // 0..1
  band: Verdict;
}

export type Verdict = "red" | "amber" | "green";

export interface NameScan {
  name: string;
  verdict: Verdict;
  heat: number;
  namesakes: ScoredNamesake[];
  searchedVariants: string[];
  notes: string[];
}

export interface CollisionDetail {
  entityId: string;
  name: string;
  type: string;
  tags: { id: string; name: string; type?: string }[];
  demographics?: DemographicSkew;
  audienceDemographics?: DemographicSkew;
}

export interface DemographicSkew {
  age: Record<string, number>;
  gender: Record<string, number>;
}

export interface ShortlistItem {
  name: string;
  verdict: Verdict;
  rationale: string;
  evidenceIds: string[];
}

export interface FinalReport {
  shortlist: ShortlistItem[];
  memo: string;
  attorneyQuestions: string[];
  planner: "llm-agent" | "deterministic";
}

/** Events streamed to the browser as NDJSON. */
export type RunEvent =
  | { type: "status"; message: string }
  | { type: "audience"; audience: ResolvedAudience }
  | { type: "qloo_call"; call: import("../qloo/types").QlooCallRecord }
  | { type: "scan"; scan: NameScan; origin: "user" | "agent" }
  | { type: "collision_detail"; detail: CollisionDetail }
  | { type: "agent_thought"; text: string }
  | { type: "tool_use"; tool: string; input: unknown }
  | { type: "final"; report: FinalReport }
  | { type: "error"; message: string; code?: string }
  | { type: "done"; stats: RunStats };

export interface RunStats {
  qlooCalls: number;
  qlooCached: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}
