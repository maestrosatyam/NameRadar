import { describe, expect, it, vi } from "vitest";
import { QlooClient } from "@/lib/qloo/client";
import { TtlCache } from "@/lib/qloo/cache";
import { extractJson, NebiusClient, stripReasoning, type ChatMessage } from "@/lib/llm/nebius";
import { runAgent, type AgentContext } from "@/lib/radar/agent";
import type { RunEvent } from "@/lib/radar/types";

function completion(message: Record<string, unknown>, finish = "stop") {
  return new Response(
    JSON.stringify({ choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function toolCall(id: string, name: string, args: unknown) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

describe("Nebius Token Factory client", () => {
  it("posts OpenAI-style chat completions with a Bearer key to the configured host", async () => {
    const f = vi.fn(async () => completion({ content: "ok" }));
    const llm = new NebiusClient({ apiKey: "NEBIUS-SECRET", baseUrl: "https://api.example.test/v1/", fetchImpl: f as unknown as typeof fetch });
    const out = await llm.chat({ messages: [{ role: "user", content: "hi" }], model: "m" });
    expect(out.content).toBe("ok");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer NEBIUS-SECRET");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "m", messages: [{ role: "user", content: "hi" }], chat_template_kwargs: { enable_thinking: false } });
  });

  it("refuses insecure or credential-bearing base URLs and a missing key", () => {
    expect(() => new NebiusClient({ apiKey: "k", baseUrl: "http://evil.example.com/v1" })).toThrow(/HTTPS/);
    expect(() => new NebiusClient({ apiKey: "k", baseUrl: "https://u:p@api.example.test/v1" })).toThrow();
    expect(() => new NebiusClient({ apiKey: "" })).toThrow(/NEBIUS_API_KEY/);
  });

  it("retries 429 and 5xx, then succeeds; errors never contain the key", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("oops", { status: 503 }))
      .mockResolvedValueOnce(completion({ content: "done" }));
    const llm = new NebiusClient({ apiKey: "k", fetchImpl: f as unknown as typeof fetch, sleep: async () => {} });
    expect((await llm.chat({ messages: [{ role: "user", content: "x" }] })).content).toBe("done");
    expect(f).toHaveBeenCalledTimes(3);

    const bad = new NebiusClient({ apiKey: "NEBIUS-SECRET", fetchImpl: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch });
    await expect(bad.chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/401/);
    await bad.chat({ messages: [{ role: "user", content: "x" }] }).catch((e: Error) => expect(e.message).not.toContain("NEBIUS-SECRET"));
  });

  it("strips reasoning and extracts JSON from fenced or wrapped replies", () => {
    expect(stripReasoning("<think>hmm</think>Answer")).toBe("Answer");
    expect(stripReasoning("consumed opening tag</think> Answer")).toBe("Answer");
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":2} hope that helps')).toEqual({ a: 2 });
  });
});

describe("agent tool loop (fake LLM, MOCK Qloo)", () => {
  it("screens names via tools, rejects unscreened names, and locks verdicts to scans", async () => {
    const qlooFetch = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const qloo = new QlooClient({ apiKey: "k", fetchImpl: qlooFetch as unknown as typeof fetch, cache: new TtlCache({ maxEntries: 10, ttlMs: 1e6 }) });

    const replies = [
      completion({ content: "Screening one idea.", tool_calls: [toolCall("c1", "scan_names", { names: ["Zorvexa"] })] }, "tool_calls"),
      completion(
        {
          content: null,
          tool_calls: [
            toolCall("c2", "submit_report", {
              shortlist: [{ name: "Ghostname", rationale: "never screened", evidence_ids: [] }],
              memo: "m",
              attorney_questions: [],
            }),
          ],
        },
        "tool_calls",
      ),
      completion(
        {
          content: null,
          tool_calls: [
            toolCall("c3", "submit_report", {
              shortlist: [{ name: "Zorvexa", rationale: "clear", evidence_ids: ["made-up-id"] }],
              memo: "Cultural pre-screen, not trademark clearance.",
              attorney_questions: ["Knockout search?"],
            }),
          ],
        },
        "tool_calls",
      ),
    ];
    const sent: ChatMessage[][] = [];
    const llmFetch = vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).messages);
      return replies.shift()!;
    });
    const llm = new NebiusClient({ apiKey: "k", fetchImpl: llmFetch as unknown as typeof fetch });

    const events: RunEvent[] = [];
    const ctx: AgentContext = {
      qloo,
      request: { names: ["Tidal"], category: "energy drink", audience: { label: "Fans", anchors: ["X"] }, mode: "agent", targetClean: 1 },
      audience: { label: "Fans", anchors: [], unresolved: [] },
      scans: new Map(),
      emit: (e) => events.push(e),
      usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0 },
    };
    const report = await runAgent(ctx, llm);

    expect(report.planner).toBe("llm-agent");
    expect(report.shortlist).toEqual([{ name: "Zorvexa", verdict: "green", rationale: "clear", evidenceIds: [] }]);
    expect(ctx.usage.llmCalls).toBe(3);
    expect(events.some((e) => e.type === "scan" && e.scan.name === "Zorvexa")).toBe(true);
    // the unscreened name was bounced back to the model as a tool error
    const bounced = sent[2].find((m) => m.role === "tool" && m.tool_call_id === "c2");
    expect(bounced && "content" in bounced && bounced.content).toMatch(/^ERROR: .*never screened/);
    expect(sent[0][0].role).toBe("system");
  });
});
