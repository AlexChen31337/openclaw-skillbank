import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CommonMistake, Skill } from "./types.js";

// Render a Skill as an openclaw SKILL.md file with frontmatter. The description
// field controls when openclaw surfaces the skill to the model — we pack
// when_to_apply and principle into it so skill matching works.
function renderSkillMarkdown(s: Skill): string {
  const description = [s.when_to_apply, s.principle].filter(Boolean).join(" — ").replace(/\s+/g, " ").trim();
  const frontmatter = [
    "---",
    `name: ${JSON.stringify(s.title || s.id)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
  ].join("\n");

  const body: string[] = [];
  body.push(`# ${s.title || s.id}`);
  body.push("");
  if (s.principle) body.push(s.principle.trim());
  if (s.when_to_apply) {
    body.push("");
    body.push(`**When to apply:** ${s.when_to_apply.trim()}`);
  }
  if (s.example) {
    body.push("");
    body.push("## Example");
    body.push("");
    body.push(s.example.trim());
  }
  body.push("");
  body.push("---");
  body.push("");
  body.push(`<sub>Auto-distilled from agent experience (source=${s.source}, confidence=${s.confidence.toFixed(2)}, usage=${s.usage_count}, success_rate=${s.success_rate.toFixed(2)}). Do not hand-edit — regenerate via \`openclaw-skillbank sync\`.</sub>`);
  body.push("");

  return `${frontmatter}\n\n${body.join("\n")}`;
}

// Write every distilled skill to <skillsDir>/<id>/SKILL.md, pruning any
// previously-written auto skill that no longer has a matching store entry.
export function exportSkillsToOpenclaw(opts: {
  skills: Skill[];
  openclawSkillsDir: string;
  managedPrefix?: string; // prefix used to namespace auto-written skill dirs
}): { written: number; removed: number } {
  const prefix = opts.managedPrefix ?? "distilled-";
  const outRoot = opts.openclawSkillsDir;
  mkdirSync(outRoot, { recursive: true });

  const keep = new Set<string>();
  let written = 0;
  for (const s of opts.skills) {
    // Avoid double-prefix when the skill id already carries the marker
    // (e.g. distilled-<ts>-<i> emitted by the LLM distiller).
    const sanitized = sanitizeIdForPath(s.id);
    const dirName = sanitized.startsWith(prefix) ? sanitized : `${prefix}${sanitized}`;
    const dirPath = path.join(outRoot, dirName);
    mkdirSync(dirPath, { recursive: true });
    const skillPath = path.join(dirPath, "SKILL.md");
    const next = renderSkillMarkdown(s);
    // Avoid touching mtime if content unchanged.
    if (existsSync(skillPath) && readFileSync(skillPath, "utf8") === next) {
      keep.add(dirName);
      continue;
    }
    writeFileSync(skillPath, next);
    keep.add(dirName);
    written++;
  }

  let removed = 0;
  for (const entry of readdirSync(outRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(prefix)) continue;
    if (keep.has(entry.name)) continue;
    rmSync(path.join(outRoot, entry.name), { recursive: true, force: true });
    removed++;
  }

  return { written, removed };
}

function sanitizeIdForPath(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
}

export const MISTAKES_SKILL_DIRNAME = "distilled-common-failure-modes";

const MISTAKES_SKILL_DESCRIPTION =
  "Consolidated catalogue of failure modes distilled from past agent runs — retry loops, tool-argument validation errors, permission-denied responses, polling pitfalls, tilde-path misuse, premature completion assumptions, and other recurring mistakes. Consult whenever a task involves exec/process/poll, sessions_send, write/read tool calls, cron jobs, system-admin commands, file-system operations, or any long-running workflow that might loop or fail silently.";

// Render a single SKILL.md that groups every CommonMistake by task_type. This
// is the "coping" half of the pipeline — openclaw's native skill loader picks
// this up automatically because it matches the SKILL.md format, so the agent
// sees "here's what you got wrong last time, and how to avoid it" without any
// plugin/runtime hook.
export function renderMistakesSkill(mistakes: CommonMistake[]): string {
  const frontmatter = [
    "---",
    `name: ${JSON.stringify("Common Failure Modes to Avoid")}`,
    `description: ${JSON.stringify(MISTAKES_SKILL_DESCRIPTION)}`,
    "---",
  ].join("\n");

  const body: string[] = [];
  body.push("# Common Failure Modes to Avoid");
  body.push("");
  body.push(`Auto-distilled from ${mistakes.length} past agent failures. Grouped by task type. When a current task matches one of these patterns, apply the corresponding fix rather than repeating the mistake.`);
  body.push("");

  // Group by task_type. Empty/undefined task_type is bucketed under "(general)".
  const grouped = new Map<string, CommonMistake[]>();
  for (const m of mistakes) {
    const key = (m.task_type && m.task_type.trim()) || "(general)";
    const arr = grouped.get(key) ?? [];
    arr.push(m);
    grouped.set(key, arr);
  }

  // Sort task types: general first, then by descending group size.
  const ordered = [...grouped.entries()].sort((a, b) => {
    if (a[0] === "(general)") return -1;
    if (b[0] === "(general)") return 1;
    return b[1].length - a[1].length;
  });

  for (const [taskType, group] of ordered) {
    body.push(`## ${taskType} (${group.length})`);
    body.push("");
    for (const m of group) {
      const desc = (m.description || "").trim();
      const why = (m.why_it_happens || "").trim();
      const fix = (m.how_to_avoid || "").trim();
      if (!desc && !fix) continue;
      body.push(`- **${desc || "(no description)"}**`);
      if (why) body.push(`  Why: ${why}`);
      if (fix) body.push(`  Fix: ${fix}`);
    }
    body.push("");
  }

  body.push("---");
  body.push("");
  body.push(`<sub>Auto-generated by openclaw-skillbank. Regenerated on each \`sync\`; do not hand-edit.</sub>`);
  body.push("");

  return `${frontmatter}\n\n${body.join("\n")}`;
}

// Write the aggregate mistakes skill to <openclawSkillsDir>/<dirname>/SKILL.md.
// Returns true if the file changed. When `mistakes` is empty, an existing
// aggregate skill is removed so stale data doesn't linger.
export function exportMistakesToOpenclaw(opts: {
  mistakes: CommonMistake[];
  openclawSkillsDir: string;
}): { written: boolean; removed: boolean } {
  const dir = path.join(opts.openclawSkillsDir, MISTAKES_SKILL_DIRNAME);
  const file = path.join(dir, "SKILL.md");

  if (opts.mistakes.length === 0) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      return { written: false, removed: true };
    }
    return { written: false, removed: false };
  }

  mkdirSync(dir, { recursive: true });
  const next = renderMistakesSkill(opts.mistakes);
  if (existsSync(file) && readFileSync(file, "utf8") === next) {
    return { written: false, removed: false };
  }
  writeFileSync(file, next);
  return { written: true, removed: false };
}
