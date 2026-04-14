import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { Skill, CommonMistake } from "./types.js";

export class NotFoundError extends Error { constructor(id: string) { super(`skillbank: not found: ${id}`); } }
export class DuplicateIdError extends Error { constructor(id: string) { super(`skillbank: duplicate id: ${id}`); } }

// FileStore is a JSONL-backed store for Skills and CommonMistakes. On-disk
// layout matches the Go reference (skillbank.jsonl + skillbank_mistakes.jsonl)
// so the two implementations stay interoperable.
export class FileStore {
  private skills = new Map<string, Skill>();
  private mistakes = new Map<string, CommonMistake>();
  private readonly skillPath: string;
  private readonly mistakePath: string;

  constructor(jsonlPath: string) {
    const ext = path.extname(jsonlPath);
    const base = jsonlPath.slice(0, jsonlPath.length - ext.length);
    this.skillPath = jsonlPath;
    this.mistakePath = `${base}_mistakes${ext}`;
    mkdirSync(path.dirname(this.skillPath), { recursive: true });
    this.load();
  }

  private load() {
    loadJsonl<Skill>(this.skillPath, (s) => { this.skills.set(s.id, s); });
    loadJsonl<CommonMistake>(this.mistakePath, (m) => { this.mistakes.set(m.id, m); });
  }

  // --- Skills ---

  add(skill: Skill): void {
    if (this.skills.has(skill.id)) throw new DuplicateIdError(skill.id);
    this.skills.set(skill.id, skill);
    this.flushSkills();
  }

  get(id: string): Skill {
    const s = this.skills.get(id);
    if (!s) throw new NotFoundError(id);
    return s;
  }

  list(category?: string): Skill[] {
    const all = [...this.skills.values()];
    return category ? all.filter((s) => s.category === category) : all;
  }

  update(skill: Skill): void {
    if (!this.skills.has(skill.id)) throw new NotFoundError(skill.id);
    this.skills.set(skill.id, skill);
    this.flushSkills();
  }

  delete(id: string): void {
    if (!this.skills.delete(id)) throw new NotFoundError(id);
    this.flushSkills();
  }

  count(): number { return this.skills.size; }

  // --- Mistakes ---

  addMistake(m: CommonMistake): void {
    if (this.mistakes.has(m.id)) throw new DuplicateIdError(m.id);
    this.mistakes.set(m.id, m);
    this.flushMistakes();
  }

  listMistakes(taskType?: string): CommonMistake[] {
    const all = [...this.mistakes.values()];
    return taskType ? all.filter((m) => (m.task_type ?? "") === taskType) : all;
  }

  deleteMistake(id: string): void {
    if (!this.mistakes.delete(id)) throw new NotFoundError(id);
    this.flushMistakes();
  }

  // --- persistence ---

  private flushSkills() { atomicWriteJsonl(this.skillPath, [...this.skills.values()]); }
  private flushMistakes() { atomicWriteJsonl(this.mistakePath, [...this.mistakes.values()]); }
}

function loadJsonl<T>(filePath: string, each: (obj: T) => void): void {
  if (!existsSync(filePath)) return;
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { each(JSON.parse(t) as T); } catch { /* skip malformed */ }
  }
}

function atomicWriteJsonl<T>(filePath: string, rows: T[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  renameSync(tmp, filePath);
}

// Append a batch of arbitrary JSONL rows. Used for archived_skills.jsonl and
// externally by ingest pipelines.
export function appendJsonl(filePath: string, rows: unknown[]): void {
  if (rows.length === 0) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
