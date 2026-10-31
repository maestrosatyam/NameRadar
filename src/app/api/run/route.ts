import { QlooClient } from "@/lib/qloo/client";
import { QlooError } from "@/lib/qloo/types";
import { llmConfigured } from "@/lib/llm/nebius";
import { runAgent, runDeterministic } from "@/lib/radar/agent";
import { normalize } from "@/lib/radar/match";
import { resolveAudience, scanName } from "@/lib/radar/scan";
import { RunRequestSchema, type NameScan, type RunEvent } from "@/lib/radar/types";
import { clientIp, take, takeDailyRun, tooMany } from "@/lib/server/ratelimit";

export const maxDuration = 120;

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const parsed = RunRequestSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "Invalid request", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
  }
  const perMin = Number(process.env.RUN_RATE_PER_MIN ?? 3);
  if (!take(`run:${clientIp(req)}`, Math.max(2, perMin * 2), perMin)) return tooMany();
  if (!takeDailyRun()) return tooMany("Daily demo capacity reached. Please try again tomorrow.");
  const request = parsed.data;

  const encoder = new TextEncoder();
  const started = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (e: RunEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          closed = true;
        }
      };
      const usage = { llmCalls: 0, inputTokens: 0, outputTokens: 0 };
      let qloo: QlooClient | undefined;
      try {
        qloo = new QlooClient({ callBudget: 120, onCall: (call) => emit({ type: "qloo_call", call }) });
        emit({ type: "status", message: "Finding your audience in Qloo's taste graph…" });
        const audience = await resolveAudience(qloo, request.audience);
        emit({ type: "audience", audience });
        if (audience.anchors.length === 0 && !audience.ageBuckets?.length && !audience.region) {
          emit({
            type: "error",
            code: "AUDIENCE_UNRESOLVED",
            message: "None of your audience examples were found in Qloo. Try well-known brands, artists, or shows your customers love.",
          });
          return;
        }

        const scans = new Map<string, NameScan>();
        for (const name of request.names) {
          emit({ type: "status", message: `Searching Qloo for namesakes of “${name}”…` });
          const scan = await scanName(qloo, name, audience);
          scans.set(normalize(name), scan);
          emit({ type: "scan", scan, origin: "user" });
        }

        if (request.mode === "agent") {
          const ctx = { qloo, request, audience, scans, emit, usage, signal: req.signal };
          let report;
          if (llmConfigured()) {
            emit({ type: "status", message: "Agent is reviewing the evidence…" });
            try {
              report = await runAgent(ctx);
            } catch (err) {
              emit({
                type: "status",
                message: `Language model unavailable (${(err as Error).message.slice(0, 120)}); switching to the deterministic planner.`,
              });
              report = await runDeterministic(ctx);
            }
          } else {
            emit({ type: "status", message: "No language model configured; using the deterministic planner." });
            report = await runDeterministic(ctx);
          }
          emit({ type: "final", report });
        }
      } catch (err) {
        const e = err as Error;
        emit({
          type: "error",
          code: e instanceof QlooError ? e.code : "INTERNAL",
          message: e instanceof QlooError ? e.message : "Something went wrong while running the radar.",
        });
        if (!(e instanceof QlooError)) console.error("run failed", e);
      } finally {
        emit({
          type: "done",
          stats: {
            qlooCalls: qloo?.calls.length ?? 0,
            qlooCached: qloo?.calls.filter((c) => c.cached).length ?? 0,
            ...usage,
            ms: Date.now() - started,
          },
        });
        closed = true;
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
