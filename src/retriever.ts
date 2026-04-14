import type { Skill } from "./types.js";
import type { FileStore } from "./store.js";

// Keyword-based retriever. Embeddings-backed retrieval is out of scope for the
// initial port; this covers the Go reference's TemplateRetriever.
export class TemplateRetriever {
  constructor(private readonly store: FileStore) {}

  retrieve(taskDescription: string, k: number): Skill[] {
    const query = tokenize(taskDescription);
    if (query.size === 0) return [];
    const skills = this.store.list();
    if (skills.length === 0) return [];

    const scored = skills
      .map((s) => ({ skill: s, score: overlapScore(query, s) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, Math.max(0, k)).map((c) => c.skill);
  }
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

function overlapScore(query: Set<string>, s: Skill): number {
  const skillTokens = tokenize(`${s.title} ${s.principle} ${s.when_to_apply} ${s.task_type} ${s.category}`);
  if (skillTokens.size === 0) return 0;
  let hits = 0;
  for (const q of query) if (skillTokens.has(q)) hits++;
  return hits / Math.max(1, query.size);
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "when", "have", "has", "had",
  "will", "not", "but", "can", "all", "any", "are", "was", "were", "been", "being",
  "which", "into", "about", "there", "their", "them", "they", "these", "those",
  "than", "then", "your", "you", "our", "ours", "its", "also", "just", "only",
]);
