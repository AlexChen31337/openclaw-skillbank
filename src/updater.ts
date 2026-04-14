import path from "node:path";
import type { Skill, Trajectory } from "./types.js";
import { DuplicateIdError, FileStore, appendJsonl } from "./store.js";
import type { Distiller } from "./distiller.js";

const EMA_ALPHA = 0.1;
const ARCHIVE_FILE = "archived_skills.jsonl";

export class SkillUpdater {
  constructor(
    private readonly distiller: Distiller,
    private readonly store: FileStore,
    private readonly archiveDir: string = ".",
  ) {}

  // Distill new skills from failure trajectories not covered by existing skills,
  // persist them, and return what was added.
  async update(failures: Trajectory[], currentSkills: Skill[]): Promise<Skill[]> {
    const uncovered = filterUncovered(failures, currentSkills);
    if (uncovered.length === 0) return [];

    const { skills: newSkills, mistakes: newMistakes } = await this.distiller.distill(uncovered);
    const added: Skill[] = [];

    for (const s of newSkills) {
      try { this.store.add(s); added.push(s); }
      catch (e) { if (!(e instanceof DuplicateIdError)) throw e; }
    }
    for (const m of newMistakes) {
      try { this.store.addMistake(m); }
      catch (e) { if (!(e instanceof DuplicateIdError)) throw e; }
    }
    return added;
  }

  // Archive skills below minSuccessRate that have been used at least minUsage times.
  pruneStaleSkills(minSuccessRate: number, minUsage: number): number {
    const skills = this.store.list();
    const toArchive = skills.filter((s) => s.usage_count >= minUsage && s.success_rate < minSuccessRate);
    if (toArchive.length === 0) return 0;

    appendJsonl(path.join(this.archiveDir, ARCHIVE_FILE), toArchive);
    for (const s of toArchive) this.store.delete(s.id);
    return toArchive.length;
  }

  // Exponential-moving-average update of a skill's success_rate (alpha=0.1).
  boostSkillConfidence(skillId: string, succeeded: boolean): void {
    const s = this.store.get(skillId);
    const outcome = succeeded ? 1.0 : 0.0;
    const updated: Skill = {
      ...s,
      success_rate: EMA_ALPHA * outcome + (1 - EMA_ALPHA) * s.success_rate,
      usage_count: s.usage_count + 1,
      updated_at: new Date().toISOString(),
    };
    this.store.update(updated);
  }
}

// A trajectory is "covered" if its task_type matches an existing skill or if
// a general skill (empty task_type) exists.
export function filterUncovered(failures: Trajectory[], skills: Skill[]): Trajectory[] {
  const covered = new Set<string>();
  let hasGeneral = false;
  for (const s of skills) {
    if (s.task_type === "") hasGeneral = true;
    else covered.add(s.task_type);
  }
  if (hasGeneral) return [];
  return failures.filter((f) => !covered.has(f.task_type));
}
