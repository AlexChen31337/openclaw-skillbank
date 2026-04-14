import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Trajectory } from "./types.js";

// Our bridge (openclaw-skillbank-bridge/batch-export.mjs) appends one row per
// trajectory to skillbank.jsonl. Each row is a Skill-shaped envelope with
// source="trajectory" and a `_raw` field carrying the full Trajectory.
interface TrajectoryEnvelope { id: string; source?: string; _raw?: Trajectory }

export interface TrajectoryCursor { lastOffset: number }

export function loadNewTrajectories(
  jsonlPath: string,
  cursorPath: string,
): { trajectories: Trajectory[]; ids: string[]; nextOffset: number } {
  if (!existsSync(jsonlPath)) return { trajectories: [], ids: [], nextOffset: 0 };
  const cursor = readCursor(cursorPath);
  const raw = readFileSync(jsonlPath, "utf8");

  // If the file has shrunk (truncated/rotated), reset.
  const startOffset = cursor.lastOffset <= raw.length ? cursor.lastOffset : 0;
  const tail = raw.slice(startOffset);
  const nextOffset = raw.length;

  const trajectories: Trajectory[] = [];
  const ids: string[] = [];
  for (const line of tail.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const env = JSON.parse(t) as TrajectoryEnvelope;
      if (env.source !== "trajectory" || !env._raw) continue;
      trajectories.push(env._raw);
      ids.push(env.id);
    } catch { /* skip malformed */ }
  }
  return { trajectories, ids, nextOffset };
}

export function saveCursor(cursorPath: string, nextOffset: number): void {
  mkdirSync(path.dirname(cursorPath), { recursive: true });
  writeFileSync(cursorPath, JSON.stringify({ lastOffset: nextOffset, savedAt: new Date().toISOString() }, null, 2));
}

function readCursor(cursorPath: string): TrajectoryCursor {
  try { return JSON.parse(readFileSync(cursorPath, "utf8")) as TrajectoryCursor; }
  catch { return { lastOffset: 0 }; }
}
