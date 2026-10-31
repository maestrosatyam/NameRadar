/**
 * Minimal client for Nebius Token Factory's OpenAI-compatible chat completions API.
 *
 * Server-side only: the key is read from NEBIUS_API_KEY and sent only as a Bearer
 * header to the configured HTTPS host. Retries 429/5xx with bounded backoff and
 * separates the model's reasoning (`reasoning_content` or inline <think> blocks)
 * from its answer.
 */

export const NEBIUS_DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/v1";
export const LLM_MODEL = process.env.NEBIUS_MODEL ?? "nvidia/Nemotron-3_5-Lightning";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const THINK_RE = /<think>[\s\S]*?<\/think>/g;

export function llmConfigured(): boolean {
  return Boolean(process.env.NEBIUS_API_KEY);
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDef[];
  /** Force a specific tool; default lets the model choose. */
  forceTool?: string;
  responseFormat?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number };
}

export interface NebiusOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class LlmError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "LlmError";
  }
}

/** Strip reasoning from an answer: inline <think> blocks, or a leading block whose opening tag the chat template consumed. */
export function stripReasoning(content: string | null | undefined): string {
  let text = (content ?? "").replace(THINK_RE, "");
  const close = text.indexOf("</think>");
  if (close !== -1) text = text.slice(close + "</think>".length);
  return text.trim();
}

/** Parse the first JSON object in a model reply, tolerating code fences and surrounding prose. */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fence ? fence[1] : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const first = body.indexOf("{");
    const last = body.lastIndexOf("}");
    if (first !== -1 && last > first) return JSON.parse(body.slice(first, last + 1));
    throw new LlmError("Model reply contained no JSON object.");
  }
}

export class NebiusClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: NebiusOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.NEBIUS_API_KEY ?? "";
    if (!this.apiKey) throw new LlmError("NEBIUS_API_KEY is not configured.");
    const baseUrl = (opts.baseUrl ?? process.env.NEBIUS_BASE_URL ?? NEBIUS_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new LlmError("NEBIUS_BASE_URL must use HTTPS.");
    }
    if (url.username || url.password || url.search) throw new LlmError("NEBIUS_BASE_URL must not carry credentials or a query string.");
    this.baseUrl = baseUrl;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model ?? LLM_MODEL,
      messages: req.messages,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.6,
      // Nemotron reasoning off by default: lower latency, and verdicts come from Qloo anyway.
      chat_template_kwargs: { enable_thinking: process.env.NEBIUS_THINKING === "true" },
    };
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = req.forceTool ? { type: "function", function: { name: req.forceTool } } : "auto";
    }
    if (req.responseFormat) body.response_format = req.responseFormat;

    let lastError: LlmError = new LlmError("Language model request failed.");
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (req.signal?.aborted) throw new LlmError("aborted");
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
      } catch {
        if (req.signal?.aborted) throw new LlmError("aborted");
        lastError = new LlmError(timeout.aborted ? "Language model request timed out." : "Language model network error.");
        if (attempt < this.maxAttempts) await this.sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      if (!res.ok) {
        lastError = new LlmError(`Language model error ${res.status}.`, res.status);
        if (RETRYABLE.has(res.status) && attempt < this.maxAttempts) {
          const retryAfter = Math.min(Number(res.headers.get("retry-after")) || 0, 10) * 1000;
          await this.sleep(Math.max(retryAfter, (res.status === 429 ? 1000 : 400) * 2 ** (attempt - 1)));
          continue;
        }
        throw lastError;
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = data.choices?.[0];
      if (!choice?.message) throw new LlmError("Language model returned no message.");
      return {
        content: stripReasoning(choice.message.content),
        toolCalls: choice.message.tool_calls ?? [],
        finishReason: choice.finish_reason ?? null,
        usage: { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 },
      };
    }
    throw lastError;
  }
}
