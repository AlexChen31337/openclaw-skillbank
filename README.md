# openclaw-skillbank

Autonomous skill distillation for [OpenClaw](https://openclaw.ai).

Reads agent trajectories (what the agent tried, what it observed), uses an LLM
to distill reusable **skills** and **common mistakes** from them, and writes
the results as openclaw `SKILL.md` files so the agent picks them up on the next
turn. Inspired by [SKILLRL](https://arxiv.org/) and ported from
[evoclaw/internal/skillbank](https://github.com/clawinfra/evoclaw) (Go) to
TypeScript.

## Why

OpenClaw's native skills are hand-authored. This package closes the loop:
agent runs → trajectory captured → LLM extracts patterns → new skills land in
the skills directory → future turns benefit.

It is intentionally **not** an openclaw plugin. OpenClaw's plugin API imports
from private hashed bundles that change on every release, which makes third-
party plugins fragile. Instead, this runs as a sibling Node service that
writes into the standard `~/.openclaw/skills/` directory — the same interface
hand-authored skills use — so it keeps working across openclaw upgrades.

## Architecture

```
openclaw sessions (*.jsonl)                       ~/.openclaw-skillbank/
        │                                              skillbank.jsonl   (skills)
        ▼                                              skillbank_mistakes.jsonl
 [openclaw-skillbank-bridge]   ─── feed ──▶  [openclaw-skillbank] ──┐
 trajectories.jsonl                          distill / update /     │
                                             prune / retrieve       ▼
                                                             ~/.openclaw/skills/
                                                             distilled-<id>/SKILL.md
                                                             (openclaw's existing loader
                                                              picks these up)
```

- **Distiller** — posts batches of trajectories to an OpenAI-compatible chat
  endpoint (the openclaw gateway by default) and parses a strict JSON response
  into `Skill` + `CommonMistake` records.
- **Updater** — filters failure trajectories against existing skills, adds
  newly-distilled skills, archives stale ones via EMA confidence tracking.
- **Retriever** — keyword overlap (Jaccard on tokenised fields) for top-k
  skill lookup; zero extra infrastructure.
- **Injector** — formats a "Relevant Skills from Past Experience" +
  "Common Mistakes to Avoid" markdown block suitable for prepending to a
  system prompt.
- **OpenClaw exporter** — writes each skill as a namespaced
  `distilled-<id>/SKILL.md` under `~/.openclaw/skills/`, pruning dirs whose
  ids have since left the store.

## Install

```bash
git clone https://github.com/AlexChen31337/openclaw-skillbank.git
cd openclaw-skillbank
npm install
npm run build
```

Optionally symlink the CLI onto your PATH:

```bash
ln -s "$(pwd)/dist/cli.js" ~/.local/bin/openclaw-skillbank
chmod +x dist/cli.js
```

## Use

```bash
# One-shot: ingest new trajectories, distill, write SKILL.md files.
openclaw-skillbank sync

# Individual steps.
openclaw-skillbank distill          # populate the store
openclaw-skillbank export           # render store → ~/.openclaw/skills/distilled-*/
openclaw-skillbank prune            # archive stale skills
openclaw-skillbank list             # inspect current skills
openclaw-skillbank retrieve "publish a telegram alert when BTC crosses 100k"
openclaw-skillbank stats
```

## Run on a timer

```bash
# 1. Generate the env file by extracting a non-conflicting provider from openclaw.json.
#    Defaults pick anthropic-proxy-6 (z.ai) so distillation never shares a
#    rate-limit bucket with your live agent.
node scripts/extract-config.mjs --write   # writes ~/.config/openclaw-skillbank.env

# 2. Install + enable the timer.
install -d ~/.config/systemd/user
install -m 0644 systemd/openclaw-skillbank.service ~/.config/systemd/user/
install -m 0644 systemd/openclaw-skillbank.timer   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now openclaw-skillbank.timer
```

Default cadence is **6 h** with a 15 min boot delay and 15 min jitter. This is
deliberate: distillation isn't time-sensitive, and pacing it widely apart
gives the rate-limit backoff and busy-guard plenty of room to do their job
without paying for unnecessary work.

### Why a separate provider matters

If you point distillation at the same provider your live agent uses (e.g.
`claude-code-plugin` backed by your Claude Pro subscription), a 17-batch
distill run can saturate the shared rate-limit bucket and break user-facing
turns for many minutes. The shipped defaults route through z.ai, which has
its own bucket. If you must use the same provider, the busy-guard will skip
runs while the plugin is mid-turn and the rate-limit retry will back off
exponentially — but separation is still safer.

## Configuration

All configuration is via environment variables. Defaults assume a standard
openclaw install at `~/.openclaw` with an `openclaw-skillbank-bridge`
populating `~/.evoclaw-hub/data/rsi/skillbank.jsonl`.

| Variable | Default | Purpose |
|---|---|---|
| `SKILLBANK_STORE` | `~/.openclaw-skillbank/skillbank.jsonl` | Distilled-skills store (paired `_mistakes` file alongside). |
| `SKILLBANK_TRAJECTORIES` | `~/.evoclaw-hub/data/rsi/skillbank.jsonl` | Trajectory feed (envelope rows with `source:"trajectory"` + `_raw`). |
| `SKILLBANK_CURSOR` | `~/.local/state/openclaw-skillbank/cursor.json` | Byte-offset cursor into the trajectory feed. |
| `OPENCLAW_SKILLS_DIR` | `~/.openclaw/skills` | Where `distilled-*` SKILL.md directories are written. |
| `SKILLBANK_API_URL` | `http://127.0.0.1:18789` | Distiller API base URL. The `extract-config` script overrides this to a non-conflicting upstream (e.g. `https://api.z.ai/api/anthropic`). |
| `SKILLBANK_API_KEY` | *(empty)* | Bearer / `x-api-key` for the upstream. |
| `SKILLBANK_API_FORMAT` | `openai` | `openai` (chat/completions) or `anthropic` (/v1/messages). |
| `SKILLBANK_MODEL` | `anthropic-proxy-6/glm-4.7` | Distiller model id. |
| `SKILLBANK_BATCH_SIZE` | `10` | Trajectories per LLM call. |
| `SKILLBANK_MAX_PROMPT_CHARS` | `24000` | Sub-batch chunking budget. |
| `SKILLBANK_MAX_OBSERVATION_CHARS` | `400` | Per-step observation truncation. |
| `SKILLBANK_MAX_ACTION_CHARS` | `400` | Per-step action truncation. |
| `SKILLBANK_MAX_RUN_MS` | `1800000` (30 min) | Wall-clock cap; remaining batches skipped past this. |
| `SKILLBANK_INTER_BATCH_DELAY_MS` | `1000` | Pause between successful batches; gives a shared rate-limit bucket time to recover. |
| `SKILLBANK_MAX_RATE_LIMIT_RETRIES` | `3` | Per-batch retries on 429 / "rate limit" errors. |
| `SKILLBANK_RATE_LIMIT_BASE_DELAY_MS` | `5000` | Exponential backoff base. |
| `SKILLBANK_BUSY_GUARD_URL` | `http://127.0.0.1:8091/health` | Probed before each run; if the response's `inflight` is at/above the threshold, the run is skipped. Set empty to disable. |
| `SKILLBANK_BUSY_GUARD_INFLIGHT_THRESHOLD` | `1` | Inflight count at which the guard refuses to start. |
| `SKILLBANK_PRUNE_MIN_SUCCESS_RATE` | `0.3` | `prune` threshold. |
| `SKILLBANK_PRUNE_MIN_USAGE` | `5` | Minimum usage before a skill is eligible for pruning. |
| `SKILLBANK_TOP_K` | `5` | Results returned by `retrieve`. |

## Data format

Skills and mistakes are stored as JSONL. The schema mirrors the Go reference
implementation byte-for-byte so the two can share a store without a migration:

```json
{"id":"distilled-1776137000000000000-0","title":"Check API errors",
 "principle":"Always check returned errors, never ignore them.",
 "when_to_apply":"making API calls","example":"...","category":"general",
 "task_type":"","source":"distilled","confidence":0.8,"usage_count":3,
 "success_rate":0.73,"created_at":"2026-04-14T...","updated_at":"2026-04-14T..."}
```

## Non-goals

- Not an openclaw plugin (see "Why" above).
- No embedding-based retrieval in v0.1 — keyword overlap only. PRs welcome.
- No fine-grained trajectory grading: success/quality come from upstream. The
  distiller filters failures but does not re-score.

## License

MIT — see [LICENSE](LICENSE).
