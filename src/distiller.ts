import type { CommonMistake, Skill, Trajectory } from "./types.js";
import { SOURCE_DISTILLED } from "./types.js";

export interface Distiller {
  distill(trajectories: Trajectory[]): Promise<{ skills: Skill[]; mistakes: CommonMistake[] }>;
}

export type DistillerApi = "openai" | "anthropic";

export interface LLMDistillerOptions {
  apiUrl: string; // base URL (without /v1/...)
  apiKey?: string;
  // Which wire format the endpoint speaks. "openai" → /v1/chat/completions,
  // "anthropic" → /v1/messages (also works for the openclaw claude-code-plugin).
  api?: DistillerApi;
  model?: string;
  batchSize?: number;
  temperature?: number;
  timeoutMs?: number;
  // Max tokens the distiller will request per call. Only used when the
  // endpoint requires it (Anthropic). Defaults to 2048 which comfortably fits
  // a "skills + mistakes" JSON response.
  maxOutputTokens?: number;
  // Approximate maximum prompt characters per chat-completions call. We bucket
  // trajectories into sub-batches that stay under this budget before sending.
  // Default targets ~8K tokens of user content, which fits inside small local
  // models (llama-server 4K needs maxPromptChars ≈ 12000 with some margin).
  maxPromptChars?: number;
  // Per-step observation truncation when building the prompt. Long tool
  // outputs blow up token counts; keep enough to convey the error shape.
  maxObservationChars?: number;
  // Per-step action truncation (arguments JSON can be huge).
  maxActionChars?: number;
}

const DEFAULT_MODEL = "anthropic-proxy-6/glm-4.7";
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PROMPT_CHARS = 24_000;
const DEFAULT_MAX_OBSERVATION_CHARS = 400;
const DEFAULT_MAX_ACTION_CHARS = 400;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

const SYSTEM_PROMPT = `You are an expert agent trainer. Given a batch of task trajectories, extract reusable skills and common mistakes that future agents should know.

Return ONLY valid JSON in this exact format:
{
  "skills": [
    {
      "title": "short skill name",
      "principle": "the reusable principle in 1-2 sentences",
      "when_to_apply": "condition or trigger",
      "example": "optional concrete example",
      "category": "general or specific category",
      "task_type": "task type or empty for general",
      "confidence": 0.8
    }
  ],
  "mistakes": [
    {
      "description": "what went wrong",
      "why_it_happens": "root cause",
      "how_to_avoid": "actionable fix",
      "task_type": "task type or empty"
    }
  ]
}

Focus on patterns that appear across multiple trajectories. Omit one-off flukes.`;

export class LLMDistiller implements Distiller {
  private readonly apiUrl: string;
  private readonly apiKey: string | undefined;
  private readonly api: DistillerApi;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly maxPromptChars: number;
  private readonly maxObservationChars: number;
  private readonly maxActionChars: number;
  private readonly maxOutputTokens: number;

  constructor(opts: LLMDistillerOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.api = opts.api ?? "openai";
    this.model = opts.model || DEFAULT_MODEL;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.temperature = opts.temperature ?? 0.3;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPromptChars = opts.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
    this.maxObservationChars = opts.maxObservationChars ?? DEFAULT_MAX_OBSERVATION_CHARS;
    this.maxActionChars = opts.maxActionChars ?? DEFAULT_MAX_ACTION_CHARS;
    this.maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  async distill(trajectories: Trajectory[]): Promise<{ skills: Skill[]; mistakes: CommonMistake[] }> {
    const skills: Skill[] = [];
    const mistakes: CommonMistake[] = [];

    const groups = chunkWithinBudget(trajectories, {
      batchSize: this.batchSize,
      maxPromptChars: this.maxPromptChars,
      maxObservationChars: this.maxObservationChars,
      maxActionChars: this.maxActionChars,
    });

    let batchIdx = 0;
    let failedBatches = 0;
    for (const batch of groups) {
      batchIdx++;
      try {
        const batchResult = await this.distillBatch(batch);
        skills.push(...batchResult.skills);
        mistakes.push(...batchResult.mistakes);
      } catch (err) {
        failedBatches++;
        const msg = err instanceof Error ? err.message : String(err);
        // Don't abort the whole run when a single batch fails (LLM bad JSON,
        // timeout, etc.). Surface and continue.
        process.stderr.write(`[distiller] batch ${batchIdx}/${groups.length} failed: ${msg.slice(0, 200)}\n`);
      }
    }
    if (failedBatches > 0) {
      process.stderr.write(`[distiller] ${failedBatches}/${groups.length} batches failed; produced ${skills.length} skills / ${mistakes.length} mistakes\n`);
    }
    return { skills, mistakes };
  }

  private async distillBatch(batch: Trajectory[]): Promise<{ skills: Skill[]; mistakes: CommonMistake[] }> {
    const userContent = buildPrompt(batch, { maxActionChars: this.maxActionChars, maxObservationChars: this.maxObservationChars });
    const content = this.api === "anthropic"
      ? await this.callAnthropic(userContent)
      : await this.callOpenAI(userContent);
    if (!content) throw new Error("distiller: empty completion content");
    return parseResponse(content);
  }

  private async callOpenAI(userContent: string): Promise<string> {
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: this.temperature,
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const json = await this.postJson(`${this.apiUrl}/v1/chat/completions`, headers, body) as {
      choices?: { message?: { content?: string } }[];
    };
    return json.choices?.[0]?.message?.content ?? "";
  }

  private async callAnthropic(userContent: string): Promise<string> {
    // Anthropic messages API: system is a top-level field, messages carry only
    // user/assistant. max_tokens is required.
    const body = {
      model: this.model,
      max_tokens: this.maxOutputTokens,
      temperature: this.temperature,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    // Anthropic uses x-api-key. Claude-code-plugin accepts either x-api-key or
    // authorization, but x-api-key is the canonical header.
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    const json = await this.postJson(`${this.apiUrl}/v1/messages`, headers, body) as {
      content?: { type: string; text?: string }[];
    };
    const text = (json.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
    return text;
  }

  private async postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`distiller api error ${res.status}: ${text.slice(0, 500)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

interface PromptBudget { maxActionChars: number; maxObservationChars: number }

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + `…[+${s.length - n} chars]`;
}

function buildPrompt(trajectories: Trajectory[], budget?: Partial<PromptBudget>): string {
  const b: PromptBudget = {
    maxActionChars: budget?.maxActionChars ?? Number.MAX_SAFE_INTEGER,
    maxObservationChars: budget?.maxObservationChars ?? Number.MAX_SAFE_INTEGER,
  };
  const parts: string[] = ["Here are the agent trajectories to analyze:\n"];
  trajectories.forEach((t, i) => {
    parts.push(`--- Trajectory ${i + 1} ---`);
    parts.push(`Task: ${truncate(t.task_description, 400)}`);
    parts.push(`Type: ${t.task_type}`);
    parts.push(`Success: ${t.success} | Quality: ${t.quality.toFixed(2)}`);
    t.steps.forEach((s, j) => {
      parts.push(`  Step ${j + 1}: ${truncate(s.action, b.maxActionChars)}`);
      parts.push(`    → ${truncate(s.observation, b.maxObservationChars)}`);
    });
    parts.push("");
  });
  parts.push("\nExtract reusable skills and common mistakes from the above trajectories.");
  return parts.join("\n");
}

// Greedily fill sub-batches so each one stays under maxPromptChars (bounded
// both by the user-set batchSize and by the rendered prompt length after
// truncation). Trajectories that individually overflow the budget are sent
// as a batch of one; the distillation is best-effort.
function chunkWithinBudget(
  trajectories: Trajectory[],
  cfg: { batchSize: number; maxPromptChars: number } & PromptBudget,
): Trajectory[][] {
  const batches: Trajectory[][] = [];
  let current: Trajectory[] = [];
  for (const t of trajectories) {
    const next = [...current, t];
    const promptLen = buildPrompt(next, cfg).length;
    if (current.length > 0 && (next.length > cfg.batchSize || promptLen > cfg.maxPromptChars)) {
      batches.push(current);
      current = [t];
    } else {
      current = next;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

interface RawSkill {
  title?: string; principle?: string; when_to_apply?: string; example?: string;
  category?: string; task_type?: string; confidence?: number;
}
interface RawMistake {
  description?: string; why_it_happens?: string; how_to_avoid?: string; task_type?: string;
}

// Walk a string starting at the first `{`, tracking brace depth while
// respecting string literals and escapes, and return the slice that covers a
// single top-level JSON object. If no complete object is found, return the
// original input so the subsequent JSON.parse surfaces a useful error.
function extractBalancedJsonObject(s: string): string {
  if (!s.startsWith("{")) return s;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === "\\") { escape = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return s.slice(0, i + 1); }
  }
  return s;
}

function parseResponse(raw: string): { skills: Skill[]; mistakes: CommonMistake[] } {
  let content = raw.trim();
  // Strip ```json ... ``` fences (or bare ``` ... ```).
  const fenceJson = content.indexOf("```json");
  if (fenceJson !== -1) {
    content = content.slice(fenceJson + 7);
    const end = content.indexOf("```");
    if (end !== -1) content = content.slice(0, end);
  } else {
    const fence = content.indexOf("```");
    if (fence !== -1) {
      content = content.slice(fence + 3);
      const end = content.indexOf("```");
      if (end !== -1) content = content.slice(0, end);
    }
  }
  const first = content.indexOf("{");
  if (first > 0) content = content.slice(first);
  // Models often append explanatory prose after the JSON object; bound by the
  // matching closing brace so JSON.parse doesn't choke on trailing text.
  content = extractBalancedJsonObject(content);

  const parsed = JSON.parse(content) as { skills?: RawSkill[]; mistakes?: RawMistake[] };
  const now = new Date().toISOString();
  const nano = Date.now();

  const skills: Skill[] = (parsed.skills ?? []).map((rs, i) => ({
    id: `distilled-${nano}-${i}`,
    title: rs.title ?? "",
    principle: rs.principle ?? "",
    when_to_apply: rs.when_to_apply ?? "",
    example: rs.example ?? "",
    category: rs.category || "general",
    task_type: rs.task_type ?? "",
    source: SOURCE_DISTILLED,
    confidence: rs.confidence || 0.7,
    usage_count: 0,
    success_rate: rs.confidence || 0.7,
    created_at: now,
    updated_at: now,
  }));

  const mistakes: CommonMistake[] = (parsed.mistakes ?? []).map((rm, i) => ({
    id: `mistake-${nano}-${i}`,
    description: rm.description ?? "",
    why_it_happens: rm.why_it_happens ?? "",
    how_to_avoid: rm.how_to_avoid ?? "",
    task_type: rm.task_type,
  }));

  return { skills, mistakes };
}
