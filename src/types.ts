// Types mirror github.com/clawinfra/evoclaw/internal/skillbank/types.go so JSONL
// records are interoperable with the Go implementation.

export interface Skill {
  id: string;
  title: string;
  principle: string;
  when_to_apply: string;
  example?: string;
  category: string; // "general" or task-specific
  task_type: string; // empty = general
  source: SkillSource;
  confidence: number; // 0..1
  usage_count: number;
  success_rate: number;
  created_at: string; // RFC3339
  updated_at: string; // RFC3339
}

export interface CommonMistake {
  id: string;
  description: string;
  why_it_happens: string;
  how_to_avoid: string;
  task_type?: string;
}

export interface Trajectory {
  task_description: string;
  task_type: string;
  steps: TrajectoryStep[];
  success: boolean;
  quality: number; // 0..1
}

export interface TrajectoryStep {
  action: string;
  observation: string;
  timestamp: string; // RFC3339
}

export type SkillSource = "distilled" | "manual" | "evolved" | "trajectory";

export const SOURCE_DISTILLED: SkillSource = "distilled";
export const SOURCE_MANUAL: SkillSource = "manual";
export const SOURCE_EVOLVED: SkillSource = "evolved";
export const SOURCE_TRAJECTORY: SkillSource = "trajectory";
