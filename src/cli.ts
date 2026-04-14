#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { FileStore } from "./store.js";
import { LLMDistiller } from "./distiller.js";
import { SkillUpdater } from "./updater.js";
import { TemplateRetriever } from "./retriever.js";
import { formatForPrompt } from "./injector.js";
import { exportSkillsToOpenclaw } from "./openclaw.js";
import { loadNewTrajectories, saveCursor } from "./trajectories.js";
import type { Trajectory } from "./types.js";

const HOME = os.homedir();

interface Env {
  storePath: string;       // skills jsonl (paired with _mistakes)
  archiveDir: string;      // where archived_skills.jsonl is written
  trajectoriesPath: string; // rsi skillbank.jsonl feed from the bridge
  cursorPath: string;
  openclawSkillsDir: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  batchSize: number;
  maxPromptChars: number;
  maxObservationChars: number;
  maxActionChars: number;
  minSuccessRate: number;
  minUsage: number;
  topK: number;
}

function env(): Env {
  const storePath = process.env.SKILLBANK_STORE || path.join(HOME, ".openclaw-skillbank/skillbank.jsonl");
  return {
    storePath,
    archiveDir: process.env.SKILLBANK_ARCHIVE_DIR || path.dirname(storePath),
    trajectoriesPath: process.env.SKILLBANK_TRAJECTORIES || path.join(HOME, ".evoclaw-hub/data/rsi/skillbank.jsonl"),
    cursorPath: process.env.SKILLBANK_CURSOR || path.join(HOME, ".local/state/openclaw-skillbank/cursor.json"),
    openclawSkillsDir: process.env.OPENCLAW_SKILLS_DIR || path.join(HOME, ".openclaw/skills"),
    apiUrl: process.env.SKILLBANK_API_URL || "http://127.0.0.1:18789",
    apiKey: process.env.SKILLBANK_API_KEY || "",
    model: process.env.SKILLBANK_MODEL || "anthropic-proxy-6/glm-4.7",
    batchSize: Number(process.env.SKILLBANK_BATCH_SIZE ?? 10),
    maxPromptChars: Number(process.env.SKILLBANK_MAX_PROMPT_CHARS ?? 24000),
    maxObservationChars: Number(process.env.SKILLBANK_MAX_OBSERVATION_CHARS ?? 400),
    maxActionChars: Number(process.env.SKILLBANK_MAX_ACTION_CHARS ?? 400),
    minSuccessRate: Number(process.env.SKILLBANK_PRUNE_MIN_SUCCESS_RATE ?? 0.3),
    minUsage: Number(process.env.SKILLBANK_PRUNE_MIN_USAGE ?? 5),
    topK: Number(process.env.SKILLBANK_TOP_K ?? 5),
  };
}

function usage(): never {
  console.error(`openclaw-skillbank <command>

Commands:
  distill [--dry-run]         Ingest new trajectories, distill into skills, persist to store.
  export                      Render store skills to SKILL.md files under OPENCLAW_SKILLS_DIR.
  sync                        distill + export (intended for the systemd timer).
  retrieve <task description> Print top-K skills relevant to a task description.
  prune                       Archive stale skills (success_rate < SKILLBANK_PRUNE_MIN_SUCCESS_RATE).
  list [--json]               List skills currently in the store.
  stats                       Print store + trajectory counts.

Environment variables (all optional):
  SKILLBANK_STORE         skills jsonl path (default: ~/.openclaw-skillbank/skillbank.jsonl)
  SKILLBANK_TRAJECTORIES  trajectories feed (default: ~/.evoclaw-hub/data/rsi/skillbank.jsonl)
  SKILLBANK_CURSOR        trajectory-ingest cursor (default: ~/.local/state/openclaw-skillbank/cursor.json)
  OPENCLAW_SKILLS_DIR     where to write SKILL.md (default: ~/.openclaw/skills)
  SKILLBANK_API_URL       OpenAI-compat base URL (default: http://127.0.0.1:18789 — openclaw gateway)
  SKILLBANK_API_KEY       Bearer token for the API URL
  SKILLBANK_MODEL         distiller model id (default: anthropic-proxy-6/glm-4.7)
`);
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  const e = env();

  switch (cmd) {
    case "distill": return await distill(e, { dryRun: rest.includes("--dry-run") });
    case "export": return exportStore(e);
    case "sync": { await distill(e, { dryRun: false }); exportStore(e); return; }
    case "retrieve": return retrieve(e, rest.join(" "));
    case "prune": return prune(e);
    case "list": return list(e, rest.includes("--json"));
    case "stats": return stats(e);
    default: usage();
  }
}

async function distill(e: Env, opts: { dryRun: boolean }): Promise<void> {
  const { trajectories, nextOffset } = loadNewTrajectories(e.trajectoriesPath, e.cursorPath);
  console.error(`[distill] loaded ${trajectories.length} new trajectories from ${e.trajectoriesPath}`);
  if (trajectories.length === 0) return;

  // Only feed failure trajectories into the updater (it filters uncovered-task-type);
  // successes can be recorded via boostSkillConfidence once we have skills to match.
  const failures: Trajectory[] = trajectories.filter((t) => !t.success);
  console.error(`[distill] ${failures.length}/${trajectories.length} are failures; distilling those`);

  const store = new FileStore(e.storePath);
  const distiller = new LLMDistiller({
    apiUrl: e.apiUrl, apiKey: e.apiKey, model: e.model,
    batchSize: e.batchSize,
    maxPromptChars: e.maxPromptChars,
    maxObservationChars: e.maxObservationChars,
    maxActionChars: e.maxActionChars,
  });
  const updater = new SkillUpdater(distiller, store, e.archiveDir);

  if (opts.dryRun) {
    console.error(`[distill] --dry-run: would distill ${failures.length} failure trajectories`);
    return;
  }

  const existing = store.list();
  const added = await updater.update(failures, existing);
  console.error(`[distill] added ${added.length} skills; store now has ${store.count()} total`);
  saveCursor(e.cursorPath, nextOffset);
}

function exportStore(e: Env): void {
  const store = new FileStore(e.storePath);
  const skills = store.list();
  const { written, removed } = exportSkillsToOpenclaw({ skills, openclawSkillsDir: e.openclawSkillsDir });
  console.error(`[export] wrote ${written}, removed ${removed} stale; total skills in store: ${skills.length}`);
}

function retrieve(e: Env, task: string): void {
  if (!task) { console.error("retrieve: task description required"); process.exit(2); }
  const store = new FileStore(e.storePath);
  const retriever = new TemplateRetriever(store);
  const skills = retriever.retrieve(task, e.topK);
  const mistakes = store.listMistakes();
  process.stdout.write(formatForPrompt(skills, mistakes.slice(0, e.topK)));
}

function prune(e: Env): void {
  const store = new FileStore(e.storePath);
  const distiller = new LLMDistiller({
    apiUrl: e.apiUrl, apiKey: e.apiKey, model: e.model,
    batchSize: e.batchSize,
    maxPromptChars: e.maxPromptChars,
    maxObservationChars: e.maxObservationChars,
    maxActionChars: e.maxActionChars,
  });
  const updater = new SkillUpdater(distiller, store, e.archiveDir);
  const pruned = updater.pruneStaleSkills(e.minSuccessRate, e.minUsage);
  console.error(`[prune] archived ${pruned} stale skills`);
}

function list(e: Env, asJson: boolean): void {
  const store = new FileStore(e.storePath);
  const skills = store.list();
  if (asJson) { process.stdout.write(JSON.stringify(skills, null, 2) + "\n"); return; }
  for (const s of skills) console.log(`[${s.title}] (${s.source}, conf=${s.confidence.toFixed(2)}, sr=${s.success_rate.toFixed(2)}, use=${s.usage_count}) — ${s.principle}`);
}

function stats(e: Env): void {
  const store = new FileStore(e.storePath);
  console.log(JSON.stringify({
    store: { skills: store.count(), mistakes: store.listMistakes().length, path: e.storePath },
    trajectories: { feed: e.trajectoriesPath, cursor: e.cursorPath },
    openclawSkillsDir: e.openclawSkillsDir,
  }, null, 2));
}

main().catch((err) => {
  console.error(`[openclaw-skillbank] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
