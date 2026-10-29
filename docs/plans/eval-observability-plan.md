# Eval and observability (Phase 7)

Status: ready to plan, 2026-10-29. This is Phase 7 of `harness-performance-plan.md` ("Eval and observability app"). It is written as a brief for our own agent: a workspace thread on this repo should be able to plan and build it from this file alone.

## How to run this brief in our harness

1. Open a **workspace** thread on this repo, posture **Agent**, window **200K** (default).
2. Send: "Read `docs/plans/eval-observability-plan.md`. Plan stage E0 with the plan tool, then implement it. Stop after E0's acceptance checks pass and report." Do one stage per run; send "Continue" if a run stops at a limit.
3. Each stage below fits one run (under 2.5M prompt tokens). Stages E3+ spend model capacity; E0–E2 do not.

What this exercises in the harness (check these in the run's trace while it works):

| Harness feature | Where it should show up |
| --- | --- |
| `read_file` position header | Results start with `[lines a–b of N]`; no 3-line read walks |
| `web_fetch` query | Not expected: this brief needs no web research. Any `web_search` here is a scope smell |
| Progress steering | No `stall_nudge` in a healthy run; edits start within the first ~20% of spend |
| `delegate(explore)` | Allowed for "find every TraceEvent consumer"; must stay one or two calls |
| `delegate(review)` | Once per stage, after verification passes |
| Budget, Continue, capacity | A stage that hits `limit.tokens` ends with a handoff; Continue resumes without re-reading everything |
| Timing | The final answer's footer shows the run's start time and total duration |

## Goal

Measure harness changes with data instead of single runs: tokens, success, scope, time, capacity. Read-only over what the runtime already writes; never changes the runtime.

## Constraints (do not break)

- Nx workspace, npm. Run tasks through `npx nx run <project>:<target>`. Do not use pnpm.
- The eval code only **reads** agent data. No writes to `$AGENT_HOME` except its own `evals/` folder.
- No new LLM calls on the agent's request path. An LLM judge (E5) runs offline only.
- Do not change `TraceEvent` meanings. New fields are optional; bump `TRACE_SCHEMA_VERSION` only if a meaning changes.
- Do not commit. Leave changes in the working tree.
- Tests are deferred for the whole project; verify with typecheck and by running the CLI on real data.

## Data contract (what exists today)

All paths are under `$AGENT_HOME` (env `AGENT_HOME`; in this repo `.local/personal-assistant` at the repo root).

| Path | Content |
| --- | --- |
| `catalog.db` (SQLite) | `threads` table: `id, title, model, kind ('home'|'workspace'), workspace_root, parent_thread_id, parent_run_id, subagent_profile, context_window_mode, created_at, updated_at, last_seq` |
| `sessions/<threadId>/ledger.jsonl` | `LedgerEnvelope` per line: `{ v, seq, ts, threadId, runId, record, contentBlob?, attachments?, durationMs?, runDurationMs?, skills? }`. `record` is a chat message (user / assistant with `tool_calls` / tool) |
| `sessions/<threadId>/traces/<runId>.jsonl` | One `TraceEvent` per line, stamped `{ v: 2, ts, seq }`. Order by `seq` (per file). Types: `run_start, llm_request, llm_response, tool_start, tool_complete, tool_error, limit, run_finish, memory_gate, context_compacted, context_evicted, context_compacted_inrun, context_prefix_heavy, skill_loaded, skill_evicted, budget_warning, stall_nudge, research_gate, tool_note` (see `packages/agent-models/src/lib/trace.ts`) |
| `sessions/<threadId>/last-run.json` | `{ runId, status, incomplete, iterations, toolCalls, limitReason?, finishedAt }` |
| `sessions/<threadId>/plan.json`, `plan-log.json`, `snapshot.json`, `blobs/<sha256>` | Plan, compaction snapshot, offloaded bodies |
| `usage/usage.jsonl` | One line per finished cloud run: `{ ts, runId, threadId, model, endpoint, status, limitReason?, usage: { own, children }, balanceBefore, balanceAfter, capacity }` |

Joins:
- A sub-agent run is a **separate thread** (`parent_thread_id`, `parent_run_id` in the catalog). Its trace lives in the child thread's `traces/`; its `run_start` has `parentRunId` and `depth: 1`.
- `run_finish.usage` = `{ own, children }`, each `{ promptTokens, completionTokens, calls, estimatedCalls }`.
- Old traces may lack `seq` (fall back to file order) and may have v1 shapes (skip unknown types, never crash).

API (for the task runner, base `http://localhost:<api port>/api/agent`):
- `POST /threads` `{ kind: 'workspace', workspaceRoot, model, title }` → thread
- `POST /run` `{ threadId, message: { content }, model, posture: 'agent', webSearch, contextWindowMode }` → `{ runId }`
- `GET /run/:runId/events` (SSE, ends on `run.settled`) and `GET /threads/:id/ledger`
- `GET /usage/balance`

Existing eval code to migrate: `apps/agent/src/eval/{run-eval,metrics,scenarios}.ts` (Home Q&A scenarios run in-process).

## Shape

| Project | Kind | Owns |
| --- | --- | --- |
| `packages/agent-eval` (`@agent/agent-eval`) | Nx TS library + CLI entry | trace/ledger/catalog readers, metrics, task runner, scoring, gate |
| `apps/eval` (`@agent/eval`) | Nx Next.js app (stage E4) | viewer UI over the library's JSON output |

Generate both with Nx generators (`nx g @nx/js:lib`, `nx g @nx/next:app`); check `--help` before passing flags.

## Stages

Order: E0 → E1 → E2 → E3 → E4 → E5. Each has acceptance checks; a stage is done only when they pass.

### E0 — Reader (no model cost)

Build `packages/agent-eval` with:
- `readCatalog(home)` → threads (with parent links).
- `readRunTrace(file)` → ordered events (`seq`, else file order), unknown types kept as `{ type, raw }`.
- `listRuns(home, { threadId?, since? })` → `RunSummary[]` built from traces + `last-run.json`, with child runs nested under their parent by `parentRunId`.
- CLI: `npx nx run agent-eval:runs -- --home <path> [--thread <id>]` prints a table: runId, thread, model, depth, status, limitReason, iterations, tool calls, prompt tokens (own/children), duration.

Accept:
- `npx nx run agent-eval:typecheck` passes.
- The CLI lists thread `5255ff5c-e4a6-4199-a3b8-3a4388504285` run `d8d1e745…` with status `incomplete`, `limit.tokens`, 77 iterations, ~2.5M prompt tokens.
- A trace file with a corrupt line still loads (line skipped, warning counted).

### E1 — Metrics (no model cost)

Per run, computed only from traces/ledger/usage log:

| Metric | From |
| --- | --- |
| prompt tokens per call: median, p90, max | `llm_response.usage.promptTokens` |
| total prompt / completion, ratio | `run_finish.usage` |
| iterations, tool calls by name and stage | `llm_response`, `tool_start` |
| wall clock; final answer write time vs whole run | `run_finish.durationMs`; ledger `durationMs` / `runDurationMs` |
| time and tokens to first successful edit | first `tool_complete` of `edit_file` starting `Created`/`Patched` |
| idle share | prompt tokens spent before the first edit ÷ total |
| re-reads after eviction | `recall` calls + `read_file` of a path whose result was evicted earlier |
| child cost share | children ÷ total prompt tokens |
| steering | counts of `stall_nudge`, `research_gate`, `tool_note`, `budget_warning`, `limit` reasons |
| capacity cost | `usage.jsonl` balance delta, aggregated as "% weekly per 1M prompt tokens" per model |

CLI: `npx nx run agent-eval:metrics -- --run <runId> | --thread <id> | --since <date> [--json]`.

Accept:
- For `d8d1e745…` it reports: 0 edits, idle share 100%, ~15 consecutive small `read_file` calls on `apps/web/src/app/themes.css`, ~30 network calls.
- `--json` output validates against an exported `RunMetrics` type.

### E2 — Task suite and runner (spends capacity)

A task is a JSON file in `evals/tasks/<id>.json`:

```json
{
  "id": "studio-theme",
  "repo": { "source": "<git url or local path>", "commit": "<sha>" },
  "prompt": "…the user message…",
  "posture": "agent",
  "checks": [{ "run": "npx nx run @agent/web:build", "expectExit": 0 }],
  "files": [{ "path": "apps/web/src/app/themes.css", "mustMatch": "--background: #262624" }],
  "scope": { "allow": ["apps/web/src/app/themes.css", "apps/web/src/lib/theme-presets.ts"] },
  "budget": { "maxPromptTokens": 1500000, "maxMinutes": 20 }
}
```

Runner (`npx nx run agent-eval:run -- --task <id> --repeat 3`):
1. Fresh checkout of `repo` at `commit` into `evals/workdirs/<task>-<n>` (git worktree or clone).
2. Separate `AGENT_HOME` for the eval (`evals/home`), so eval threads never mix with personal ones; start the API against it (or require it running with that env).
3. Drive the real API over HTTP (create thread → `POST /run` → wait on SSE `run.settled`; send "Continue" up to N times on resumable limits).
4. Score: checks pass, file assertions, scope (`git diff --name-only` ⊆ `scope.allow`), budget, plus E1 metrics.
5. Write `evals/results/<date>/<task>-<n>.json`.

Respect capacity: before each run read `GET /usage/balance`; skip and report when the governor would pause.

Start with 5 tasks drawn from real work (theme change, sub-agent bug fix, docs edit, a refactor, a "plan only" request). Grow to ~20 from real failures. Move the Home Q&A scenarios from `apps/agent/src/eval` here as `home` tasks.

Accept:
- One task runs end to end three times and writes three result files.
- A deliberately failing check marks the task failed without crashing the runner.

### E3 — Baselines and gate

- `npx nx run agent-eval:baseline -- --suite core` writes `evals/baselines/core.json` (per task: success rate, median prompt tokens, median minutes, scope violations).
- `npx nx run agent-eval:gate -- --suite core` reruns and fails (exit 1) when: success drops, median prompt tokens rise >10%, or scope violations rise. Prints a diff table.
- Run by hand before merging changes to the loop, assembler, prompts, profiles, limits, or residency. Not in CI (it spends capacity).

Accept: gate passes against its own fresh baseline; editing a baseline number by hand makes it fail with a readable reason.

### E4 — Viewer app

`apps/eval` (Next.js), reading the library's JSON (local only):
- Threads → runs → iteration timeline: model calls (tokens, duration), tools (args preview, duration, result size), sub-agent runs nested inline, limits/notes/evictions/compactions as markers.
- Per-run metrics panel (E1); suite results and gate diffs (E2/E3); capacity chart from `usage.jsonl`.

Accept: `npx nx run @agent/eval:build` passes; opening run `d8d1e745…` shows the 77 iterations, the eviction markers at 25 and 61, and the `limit.tokens` end.

### E5 — Optional judge

Offline rubric (correct, in scope, verified, efficient) scored by a model over the final answer + diff. Stored next to results; never gates on its own.

## Risks

| Risk | Mitigation |
| --- | --- |
| Evals drain the weekly allowance | Governor applies; E0/E1 cost nothing; `--repeat` defaults to 1 until a task is stable |
| Model randomness | Repeat 3×; report spread, not one number |
| Fixture drift | Every task pins a commit |
| Personal data in reports | Reader stays local; results never include message bodies unless `--include-text` |
