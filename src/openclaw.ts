import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Skill } from "./types.js";

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
