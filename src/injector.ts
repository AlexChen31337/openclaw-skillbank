import type { CommonMistake, Skill } from "./types.js";

export function formatForPrompt(skills: Skill[], mistakes: CommonMistake[]): string {
  if (skills.length === 0 && mistakes.length === 0) return "";
  const parts: string[] = [];
  if (skills.length > 0) {
    parts.push("## Relevant Skills from Past Experience");
    skills.forEach((s, i) => parts.push(`${i + 1}. [${s.title}] When: ${s.when_to_apply} → ${s.principle}`));
  }
  if (mistakes.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("## Common Mistakes to Avoid");
    for (const m of mistakes) parts.push(`- ${m.description} — ${m.how_to_avoid}`);
  }
  return parts.join("\n") + "\n";
}

export function injectIntoPrompt(systemPrompt: string, skills: Skill[], mistakes: CommonMistake[]): string {
  const block = formatForPrompt(skills, mistakes);
  if (!block) return systemPrompt;
  if (!systemPrompt) return block;
  return `${block}\n${systemPrompt}`;
}
