import type { CommonMistake, Skill, Trajectory } from "./types.js";
import { SOURCE_DISTILLED } from "./types.js";

export interface Distiller {
  distill(trajectories: Trajectory[]): Promise<{ skills: Skill[]; mistakes: CommonMistake[] }>;
}

export interface LLMDistillerOptions {
  apiUrl: string; // OpenAI-compatible base URL (without /v1/...)
  apiKey?: string;
  model?: string;
  batchSize?: number;
  temperature?: number;
  timeoutMs?: number;
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
  private readonly model: string;
  private readonly batchSize: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly maxPromptChars: number;
  private readonly maxObservationChars: number;
  private readonly maxActionChars: number;

  constructor(opts: LLMDistillerOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model || DEFAULT_MODEL;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.temperature = opts.temperature ?? 0.3;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPromptChars = opts.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
    this.maxObservationChars = opts.maxObservationChars ?? DEFAULT_MAX_OBSERVATION_CHARS;
    this.maxActionChars = opts.maxActionChars ?? DEFAULT_MAX_ACTION_CHARS;
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
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: this.temperature,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let content: string;
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.apiUrl}/v1/chat/completions`, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`distiller api error ${res.status}: ${text.slice(0, 500)}`);
      }
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      content = json.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
    if (!content) throw new Error("distiller: empty completion content");
    return parseResponse(content);
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
