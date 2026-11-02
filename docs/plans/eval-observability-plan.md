# Eval and observability (Phase 7) — run brief and data contract

Status: updated 2026-10-31. Phase 7 of `harness-performance-plan.md`.

This file has two jobs: **how to run the work through our own harness**, and **the data contract** the eval code reads. The goal, rules, stages, acceptance checks and gate rules live in `eval-implementation-plan.md` (plan of record). If the two ever disagree, the implementation plan wins.

## How to run a stage in our harness

1. Open a **workspace** thread on this repo, posture **Agent**, window **200K** (default).
2. Send: "Read `docs/plans/eval-implementation-plan.md` and `docs/plans/eval-observability-plan.md`. Plan stage `<stage>` with the plan tool, then implement it. Follow rules G1–G8. Stop when that stage's Accept checks pass and every fix-ledger row it closes (§0a) is closed. Report each Accept check and each row as `F<n>: closed — <command and result>`, list the `TraceEvent` fields you used, and update the ledger's Status column." Start with **S0**, then S1, P2, E0, E1, E4a.
3. One stage per run. Each fits under the 2.5M-token run budget. If a run stops at a limit, press **Continue**.
4. S0 through E4a cost nothing beyond the run itself. E2 and later spend extra capacity on trials.

What each run exercises in the harness (check it in the run's trace or viewer):

| Harness feature | Expected in a healthy stage run |
| --- | --- |
| `read_file` position header | Results start with `[lines a–b of N]`; no walks of tiny reads |
| `web_search` / `web_fetch` | Not needed: the brief and the repo hold everything. Any web call is a scope smell |
| Progress steering | No `stall_nudge`; the first edit lands within the first ~20% of spend |
| `delegate(explore)` | At most one or two calls (for example "find every `TraceEvent` consumer") |
| `delegate(review)` | Once, after verification passes |
| Limits and Continue | A stop at `limit.tokens` ends with a handoff; Continue resumes without re-reading everything |
| Timing | The final answer's footer shows the run's start time and total duration |

## Data contract

### Personal agent data (read-only)

Under `$AGENT_HOME` (in this repo `.local/personal-assistant` at the repo root):

| Path | Content |
| --- | --- |
| `catalog.db` (SQLite, WAL mode) | `threads` table: `id, title, model, kind ('home' \| 'workspace'), workspace_root, parent_thread_id, parent_run_id, subagent_profile, context_window_mode, created_at, updated_at, last_seq`. Open with `node:sqlite` `{ readOnly: true }` |
| `sessions/<threadId>/ledger.jsonl` | `LedgerEnvelope` per line: `{ v, seq, ts, threadId, runId, record, contentBlob?, attachments?, durationMs?, runDurationMs?, skills? }`. `record` is a chat message (user / assistant with `tool_calls` / tool) |
| `sessions/<threadId>/traces/<runId>.jsonl` | One `TraceEvent` per line, stamped `{ v: 2, ts, seq }` by the sink (see `TraceLine` below). Types: `run_start, llm_request, llm_response, tool_start, tool_complete, tool_error, limit, run_finish, memory_gate, context_compacted, context_evicted, context_compacted_inrun, context_prefix_heavy, skill_loaded, skill_evicted, budget_warning, stall_nudge, research_gate, tool_note` — the source of truth is `packages/agent-models/src/lib/trace.ts` |
| `sessions/<threadId>/last-run.json` | `{ runId, status, incomplete, iterations, toolCalls, limitReason?, finishedAt }` |
| `sessions/<threadId>/plan.json`, `plan-log.json`, `snapshot.json`, `blobs/<sha256>` | Plan, compaction snapshot, offloaded bodies |
| `usage/usage.jsonl` | One line per finished cloud run: `{ ts, runId, threadId, model, endpoint, status, limitReason?, usage: { own, children }, balanceBefore, balanceAfter, capacity }` |

### Trace lines

```ts
// Exported by @agent/agent-eval's reader. v/ts/seq are stamped by the sink,
// not part of TraceEvent. Never read any other field that is not in TraceEvent.
export type TraceLine = TraceEvent & { v?: number; ts?: string; seq?: number };
```

- Order by `seq` when every line has it, else file order. Old traces may lack `seq` or carry v1 shapes: keep unknown types, skip corrupt lines and count them, never throw.
- Fields that exist today, by event (abridged): `llm_request { iteration, estimatedPromptTokens?, reasoningEffort? }`; `llm_response { iteration, finishReason, hasToolCalls, usage?, durationMs?, usageEstimated? }`; `tool_start { iteration, toolName, args }`; `tool_complete { iteration, toolName, durationMs, resultPreview (≤300 chars), resultChars? }`; `context_evicted { iteration, evicted, beforeTokens, afterTokens }`; `run_finish { iterations, toolCalls, status?, limitReason?, usage?, durationMs? }`.
- Added in stage **P2** (optional): `toolCallId` on `tool_start` / `tool_complete` / `tool_error`; `toolCallIds` on `context_evicted` and `context_compacted_inrun`. Metrics that need them report `null` on older traces.
- Edit success: `tool_complete` of `edit_file` whose `resultPreview` starts with `Created` or `Patched`.

### Joins

- A sub-agent run is a **separate thread** (`parent_thread_id`, `parent_run_id` in the catalog). Its trace is in the child thread's `traces/`; its `run_start` has `parentRunId` and `depth: 1`.
- `run_finish.usage` = `{ own, children }`, each `{ promptTokens, completionTokens, calls, estimatedCalls }`.

### Eval data

| Path | In git | Content |
| --- | --- | --- |
| `evals/tasks/{regression,capability}/*.json` | yes | Task definitions (pinned commits) |
| `evals/baselines/<suite>.json` | yes | Written only by `agent-eval baseline` |
| `.local/eval-home/` | no | The eval `AGENT_HOME` (seeded copy of skills, agents, memory; `seed.json` hash) |
| `.local/eval-home/workdirs/<task>-<n>/` | no | Trial checkouts. Never inside the repo tree (Nx would see duplicate projects) |
| `.local/eval-home/results/<ts>-<label>/` | no | Trial results and `summary.json` |

### API used by the runner

Base `http://localhost:<api port>/api/agent`; the API must run with `AGENT_HOME=.local/eval-home`.

- `POST /threads` `{ kind: 'workspace', workspaceRoot, model, title }` → thread
- `POST /run` `{ threadId, message: { content }, model, posture: 'agent', webSearch, contextWindowMode }` → `{ runId }`
- `GET /run/:runId/events` (SSE; settled on `run.settled`), `GET /threads/:id/ledger`
- `GET /usage/balance`

Existing eval code to migrate in E2: `apps/agent/src/eval/{run-eval,metrics,scenarios}.ts` (Home Q&A scenarios that call `runLoop` in-process).

## Projects

| Project | Kind | Owns |
| --- | --- | --- |
| `packages/agent-eval` (`@agent/agent-eval`) | Nx TS library + one CLI (`src/cli/main.ts`, esbuild-bundled like `@agent/cli:eval`) | readers, metrics, runner, gate |
| `apps/eval` (`@agent/eval`) | Nx Next.js app, created in E4a with `nx g @nx/next:app` (check `--help` first) | viewer over `@agent/agent-eval` |
