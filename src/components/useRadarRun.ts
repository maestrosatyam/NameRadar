"use client";

import { useCallback, useRef, useState } from "react";
import type { QlooCallRecord } from "@/lib/qloo/types";
import type {
  CollisionDetail,
  FinalReport,
  NameScan,
  ResolvedAudience,
  RunEvent,
  RunRequest,
  RunStats,
} from "@/lib/radar/types";

export interface TimelineItem {
  id: number;
  kind: "status" | "thought" | "tool" | "scan" | "error";
  text: string;
  at: number;
}

export interface RunState {
  running: boolean;
  audience?: ResolvedAudience;
  scans: NameScan[];
  scanOrigins: Record<string, "user" | "agent">;
  details: Record<string, CollisionDetail>;
  report?: FinalReport;
  calls: QlooCallRecord[];
  timeline: TimelineItem[];
  error?: { message: string; code?: string };
  stats?: RunStats;
}

const EMPTY: RunState = { running: false, scans: [], scanOrigins: {}, details: {}, calls: [], timeline: [] };

function describeTool(tool: string, input: unknown): string {
  const i = input as { names?: string[]; entity_id?: string };
  if (tool === "scan_names") return `scan_names(${(i.names ?? []).map((n) => `“${n}”`).join(", ")})`;
  if (tool === "inspect_collision") return `inspect_collision(${i.entity_id?.slice(0, 8) ?? "?"}…)`;
  if (tool === "submit_report") return "submit_report(shortlist, memo)";
  return tool;
}

export function useRadarRun() {
  const [state, setState] = useState<RunState>(EMPTY);
  const abortRef = useRef<AbortController | null>(null);
  const seq = useRef(0);

  const run = useCallback(async (request: RunRequest) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ ...EMPTY, running: true });

    const push = (s: RunState, kind: TimelineItem["kind"], text: string): RunState => ({
      ...s,
      timeline: [...s.timeline, { id: ++seq.current, kind, text, at: Date.now() }],
    });

    const apply = (e: RunEvent) =>
      setState((s) => {
        switch (e.type) {
          case "status":
            return push(s, "status", e.message);
          case "audience":
            return { ...s, audience: e.audience };
          case "qloo_call":
            return { ...s, calls: [...s.calls, e.call] };
          case "scan": {
            const others = s.scans.filter((x) => x.name.toLowerCase() !== e.scan.name.toLowerCase());
            const next = push(
              { ...s, scans: [...others, e.scan], scanOrigins: { ...s.scanOrigins, [e.scan.name]: e.origin } },
              "scan",
              `“${e.scan.name}”: ${e.scan.verdict.toUpperCase()} (${e.scan.namesakes.length} namesake${e.scan.namesakes.length === 1 ? "" : "s"})`,
            );
            return next;
          }
          case "collision_detail":
            return { ...s, details: { ...s.details, [e.detail.entityId]: e.detail } };
          case "agent_thought":
            return push(s, "thought", e.text);
          case "tool_use":
            return push(s, "tool", describeTool(e.tool, e.input));
          case "final":
            return { ...s, report: e.report };
          case "error":
            return push({ ...s, error: { message: e.message, code: e.code } }, "error", e.message);
          case "done":
            return { ...s, stats: e.stats, running: false };
        }
      });

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        setState((s) => ({
          ...s,
          running: false,
          error: { message: (body as { error?: string }).error ?? `Request failed (${res.status}).` },
        }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            apply(JSON.parse(line) as RunEvent);
          } catch {
            /* ignore malformed line */
          }
        }
      }
      setState((s) => (s.running ? { ...s, running: false } : s));
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setState((s) => ({ ...s, running: false, error: { message: "Connection lost. Please try again." } }));
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState((s) => ({ ...s, running: false }));
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(EMPTY);
  }, []);

  return { state, run, cancel, reset };
}
