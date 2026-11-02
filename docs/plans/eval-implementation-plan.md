# Eval & observability — implementation plan (plan of record)

Status: rebuilt 2026-10-31 after review. This file is the **plan of record** for Phase 7 of `harness-performance-plan.md`. It replaces the stage text in `eval-observability-plan.md` and the "doctrine implementation plan" draft. `eval-observability-plan.md` keeps the run instructions and the data contract.

A workspace thread must be able to build any stage from this file plus `eval-observability-plan.md`, without the conversation that produced them.

## 0. Where we are

| Item | State (2026-10-31) |
| --- | --- |
| P1 `reasoningEffort` on `llm_request` | Done, staged. Effort resolved by the host and passed through `RunLoopConfig` / `StartRunOptions` / `SubagentHost.reasoningEffortFor`. One cleanup left (S1). |
| `packages/agent-eval` | **S0 done 2026-10-31.** Kept and rebuilt `src/read/` against the real types (`TraceLine`, `summarizeRun`, `listRuns` with sub-agent nesting, catalog incl. `subagent_profile`, usage log shape from `capacity.ts`); deleted the premature `metrics/`, `runner/`, `gate/`, `analyst/`, `cli/`; added `tsconfig.json` (+ root reference via `nx sync`), `vitest.config.mts`, agent-core's vitest script; dropped the `@agent/agent-core` dependency. `@agent/agent-eval:typecheck` and `:test` (6 parser tests) pass. Reader checked on real data: `d8d1e745` → incomplete, `limit.tokens`, 77 iterations, 2,535,775 own prompt tokens. Note: the original draft files are still staged in the git index; the deletions are working-tree only. |
| `apps/eval`, `evals/` | Built 2026-10-31 (E4a viewer; first regression task `evals/tasks/regression/readme-glossary.json`). |
| Stages | **S0, S1, P2, E0, E1, E4a, E2, E3 built 2026-10-31.** Verified: workspace typecheck (5 projects), 38 agent-core + 6 agent-eval tests, `@agent/eval:build`, CLI on real data, viewer acceptance in a browser, runner refusal paths, checkout/grade/prune, every gate rule on synthetic results. **Not yet run:** a live trial (spends capacity; needs an API started with `AGENT_HOME=.local/eval-home`), the checkpoint week, a post-P2 trace. |

Lesson for the brief (now rule G6): the draft was written against fields the model assumed, not against `packages/agent-models/src/lib/trace.ts`. That is exactly the failure this system exists to catch.

## 0a. Fix ledger

Every fixing need found in review, with the stage that completes it and the check that proves it. **A stage is done only when its Accept lines pass and every ledger row it owns is closed.** The executing run reports each owned row as `F<n>: closed — <command and result>`, then updates the Status column here.

### Runtime fixes the plan depends on (already done)

In `HEAD` (commits `0723ce3`, `dd80d3f`). Listed because later stages rely on them; re-check if any of these files change.

| ID | Fix | Relied on by | Status |
| --- | --- | --- | --- |
| R1 | Trace sink writes each file in order and stamps a per-file `seq` (`apps/api/src/lib/trace-sink.ts`) | E0 ordering, E4a `#seq-<n>` anchors | done |
| R2 | Final answer carries `runDurationMs` (whole run), ledger + `Message` (`agent-models/ledger.ts`, `loop.ts`) | E1 wall-clock metrics | done |
| R3 | Balance refresh backs off after failures (`apps/api/src/lib/capacity.ts`) | E2 capacity check before trials | done |
| R4 | Cancelled sub-agent waiters leave the slot queue (`subagent/runner.ts` `Slots`) | E2 trials that cancel | done |
| R5 | Rewind deletes only sub-agent threads created after the cut (`thread-store.ts`) | E0 catalog joins | done |
| R6 | `diff` tool works in a repo with no commits (`tools/workspace.ts`) | E2 scope check on fresh checkouts | done |
| R7 | Runs that only retry closed web tools end with a handoff (`limit.research`, `loop.ts`) | E1 steering counts | done |

### Draft-code fixes (staged `packages/agent-eval` and P1)

| ID | Need | Completed in | Done when | Status |
| --- | --- | --- | --- | --- |
| F1 | 36 type errors from invented trace fields (`ts` on events, `tool_call` type, `context_evicted.path`) | S0 (delete `metrics/`, `runner/`, `gate/`, `analyst/`, `cli/`; fix `read/` to `TraceLine`) | `npx nx run @agent/agent-eval:typecheck` passes | closed 2026-10-31 (S0) |
| F2 | No Nx `typecheck` target, so workspace typecheck skipped the package | S0 (`tsconfig.json` with references, like `agent-models`) | `npx nx show project @agent/agent-eval` lists `typecheck` | closed 2026-10-31 (S0) |
| F3 | CLIs use top-level `await` in a CommonJS package | E0 (one esbuild-bundled `src/cli/main.ts`, `main().catch(...)`, §5) | `npx nx run @agent/agent-eval:runs -- --help` prints usage | closed 2026-10-31 (E0: `agent-eval:runs -- --help` prints usage) |
| F4 | `analyst/report.ts` re-exports from `generate.ts` (types live in the wrong file) | S0 deletes it; E6 defines `AnalystReport` in `report.ts` and `generate.ts` imports it | E6: no import from `generate.ts` in `report.ts` | open (E6) |
| F5 | `vitest.config.ts` is empty | S0 (fill it, matching `agent-core`'s config, or delete and keep the script) | `npx nx run @agent/agent-eval:test` runs the parser tests | closed 2026-10-31 (S0) |
| F6 | Package depends on `@agent/agent-core` (G7) | S0 (remove from `package.json` and imports) | `git grep "agent-core" packages/agent-eval` returns nothing | closed 2026-10-31 (S0) |
| F7 | `reasoningEffortFor` fetches the model config a second time per sub-agent spawn | S1 (memoize resolved options per model in `subagent-host.ts`) | one `getOllamaModelConfig` call per model per run (log or breakpoint), child trace still shows `reasoningEffort` | closed in code 2026-10-31 (S1: one memoized lookup per model per run); live delegated-run check pending |

### Plan-design fixes (from review)

| ID | Need | Completed in | Done when | Status |
| --- | --- | --- | --- | --- |
| F8 | Gate refused on a different `harnessSha`, so it could never test a change | E3 (§8: refuse only on model, `seedHash`, `taskHash`) | E3 Accept: a new `harnessSha` gets a verdict; a new model gets exit 2 | closed 2026-10-31 (E3: new harnessSha → verdict; new model / task hash → exit 2) |
| F9 | "Any success drop fails" is noise at 3 trials | E3 (§8 trial-count, suite-level and stable-task rules) | E3: a baseline with one flipped trial (2/3 → 1/3) passes; losing 2 trials fails | closed 2026-10-31 (E3: one flip → pass, two lost → fail; suite rule also needs ≥ 2 lost trials, §8) |
| F10 | No way to accept an intentional trade-off | E3 (`baseline --accept "<reason>"`, reason stored) | E3: the baseline file shows the reason | closed 2026-10-31 (E3: `--accept` stores `acceptReason`; failing candidate cannot replace the baseline without it) |
| F11 | "Re-reads after eviction" not computable: evictions carry no ids | P2 (`toolCallId` / `toolCallIds` trace fields) | P2 Accept; E1 reports a number on a post-P2 trace and `null` on `d8d1e745` | trace side closed 2026-10-31 (P2, typechecked); metric reports `null` on `d8d1e745`; a post-P2 live trace is pending |
| F12 | `ts`/`seq` are on the line, not in `TraceEvent` | E0 (`TraceLine` type exported by the reader) | metrics and viewer import `TraceLine`; F1 check passes | closed 2026-10-31 (E0: `TraceLine`, `linesOf`) |
| F13 | Checkouts inside the repo would add duplicate Nx projects | E2 (workdirs under `.local/eval-home/workdirs`) | after a checkout exists, `npx nx show projects` lists the same projects as before | closed 2026-10-31 (E2: `nx show projects` still lists 7 projects with a full checkout in `.local/eval-home/workdirs`) |
| F14 | An empty eval home measures a different agent | E2 (`agent-eval seed` + `seedHash`) and E3 (refuse on mismatch) | `seed.json` exists; changing a seeded skill changes `seedHash` and the gate refuses | closed 2026-10-31 (E2: `seed.json` + drift check; E3 refuses on `seedHash` mismatch) |
| F15 | Each worktree needs dependencies; full builds make trials slow | E2 (link `node_modules` when the lockfile matches, else `npm ci`; fast checks) | a trial's grading step finishes in under 2 minutes on a linked checkout | partly closed 2026-10-31: grading of the first task takes seconds; linking is implemented and prune-safe, but activates only once the current `package-lock.json` is committed (the pinned commit's lockfile differs, so the probe ran `npm ci`, 72 s) |
| F16 | Too much planned before the first baseline | Stage order (§6): MVP first, E4b/E5/E6 deferred | E4b/E5/E6 not started before the checkpoint is recorded | holding (rule): E4b/E5/E6 not started |
| F17 | Trial cost unknown | Checkpoint (record "% weekly per 1M tokens") + E2 `--max-weekly-percent` | checkpoint numbers written in §6; runner stops before the ceiling | partly closed 2026-10-31: suite ceiling enforced from the live balance; usage log already gives 0.49–1.10 % of the week per 1M prompt tokens; checkpoint record pending |
| F18 | Brief let the agent invent fields | G6 in §3 and the run brief in `eval-observability-plan.md` | each stage report says which `TraceEvent` fields it used | closed (doc) |

## 1. Goal

Measure the harness (loop + tools + gates + context + model) with data instead of single runs, so every harness change answers: did success hold, did tokens and time go down, did scope violations stay at zero, what did it cost of the weekly allowance.

**First useful version (MVP)** = S0–S2, P2, E0, E1, E4a: a free reader, metrics and a viewer over the traces we already write. Use it for about a week of normal work before spending capacity on E2/E3. E4b, E5, E6 wait until there are real failing trials to analyse.

## 2. Mental model

The unit under test is **harness + model together**.

| Concept | Here |
| --- | --- |
| Task | One JSON file in `evals/tasks/` (prompt, pinned commit, checks) |
| Trial | One task run → one `runId` (plus Continue segments) |
| Trace | `sessions/<thread>/traces/<runId>.jsonl`, ordered by `seq`; ledger is the truth for messages |
| Outcome | The workspace end state after the trial, graded by commands and file checks, **not** by the transcript |
| Suite | `regression` (should pass ~100%; gates merges) and `capability` (starts hard; never gates; graduates to regression when saturated) |

## 3. Ground rules (every stage)

- **G1 Read-only over agent data.** Open `catalog.db` with `node:sqlite` `new DatabaseSync(path, { readOnly: true })` (the catalog runs in WAL mode; a normal open writes). No writes under the personal `$AGENT_HOME`.
- **G2 Real entry point.** Trials go through `POST /api/agent/run` on a running API. Never call `runLoop` directly.
- **G3 Trace schema.** New trace fields are optional; `TRACE_SCHEMA_VERSION` changes only if a meaning changes.
- **G4 No LLM on the agent's request path.** Judges and the analyst run offline.
- **G5 One stage per workspace-thread run.** Verify with Nx typecheck + the stage's acceptance commands on real data. `delegate(review)` once after verification. Do not commit.
- **G6 No invented fields.** Import `TraceEvent` from `@agent/agent-models` and use the reader's `TraceLine` type. If a metric needs a field that is not in the type, stop and add it as an optional trace field in a P-step first.
- **G7 Dependencies.** `agent-eval` depends on `@agent/agent-models` only (types and pure helpers). Never `@agent/agent-core`, Express, or React.
- **G8 Tests.** Deferred project-wide, with one exception: fixture tests for the trace parser, because every stage depends on it.

## 4. Data contract additions

Everything else is in `eval-observability-plan.md` → "Data contract".

**TraceLine.** The JSONL sink stamps each line with `v`, `ts`, `seq`. These are not part of `TraceEvent`. The reader exports:

```ts
export type TraceLine = TraceEvent & { v?: number; ts?: string; seq?: number };
```

Order by `seq` when every line has it, else file order. Durations come from `ts` deltas or from `durationMs` fields, never from fields on the event union.

**P2 fields** (optional, added in stage P2):

| Event | New field | Why |
| --- | --- | --- |
| `tool_start`, `tool_complete`, `tool_error` | `toolCallId?: string` | Link a call to its result and its ledger row; viewer anchors |
| `context_evicted` | `toolCallIds?: string[]` | Which results left the prompt → re-reads after eviction |
| `context_compacted_inrun` | `toolCallIds?: string[]` | Same, for folded iterations |

Edit success is read from `tool_complete` of `edit_file` whose `resultPreview` starts with `Created` or `Patched` (the loop's own rule, `isEditSuccess`).

## 5. Layout

```
packages/agent-eval/                 # lib + one CLI; depends on @agent/agent-models only
  src/read/      catalog, ledger, trace (TraceLine), usage, runs (RunSummary)
  src/metrics/   RunMetrics, ThreadMetrics
  src/runner/    E2: task schema, checkout, api client, scoring
  src/gate/      E3: baseline, gate
  src/cli/main.ts                    # one entry, subcommands: runs | metrics | seed | run | baseline | gate
apps/eval/                           # E4a/E4b: Next.js viewer, server components import @agent/agent-eval
evals/                               # in git
  tasks/regression/*.json
  tasks/capability/*.json
  baselines/<suite>.json
.local/eval-home/                    # gitignored (.local/ is already ignored); Nx does not scan it
  (an AGENT_HOME: catalog.db, sessions/, skills/, agents/, usage/)
  workdirs/<task>-<n>/               # checkouts live here, never inside the repo tree
  results/<ts>-<label>/              # trial results and summary.json
```

Why the eval home is under `.local/`: checkouts contain `package.json`/`project.json` files that Nx would treat as duplicate projects if they sat inside the repo tree. A gitignored path keeps them out of the project graph and out of git.

**CLI pattern** (same as `@agent/cli:eval`): bundle `src/cli/main.ts` with esbuild (`--platform=node --format=cjs --packages=external`) and run it with `node`. No top-level `await`: `main().catch(...)`. Each subcommand gets an `nx:run-commands` target: `agent-eval:runs`, `agent-eval:metrics`, and so on, with `dependsOn: ["^build"]`.

## 6. Stages

Order: **S0 → S1 → P2 → E0 → E1 → E4a → (one week of use) → E2 → E3 → later: E4b, E5, E6.**

Each stage lists Do, then Accept. A stage is done only when every Accept line passes.

### S0 — Salvage the draft (free)

Closes: F1, F2, F5, F6 (F4 by deletion; its real fix is in E6).

Do:
- Keep `src/read/*` and `src/read/trace.test.ts`; fix them to the real types (TraceLine, G6).
- Delete `src/metrics/*`, `src/runner/*`, `src/gate/*`, `src/analyst/*`, `src/cli/*`. They are rebuilt in their own stages against the real contract.
- Package setup: add `tsconfig.json` (references `tsconfig.lib.json` and `tsconfig.spec.json`, like `packages/agent-models`), so `@nx/js/typescript` infers `typecheck`. Remove the `@agent/agent-core` dependency (G7). Fill or delete `vitest.config.ts`.

Accept:
- `npx nx show project @agent/agent-eval` lists `typecheck`.
- `npx nx run @agent/agent-eval:typecheck` and `npx nx run @agent/agent-eval:test` pass.

### S1 — P1 cleanup (free)

Closes: F7.

Do: resolve call options once per model in `apps/api/src/lib/subagent-host.ts` (memoize the resolved options per model; `modelCall` and `reasoningEffortFor` share them), so a child spawn does not fetch the model config twice.

Accept: a delegated run's child trace shows `reasoningEffort` on `llm_request`; `npx nx run-many -t typecheck` passes.

### P2 — Trace ids (free, runtime change)

Closes: F11 (trace side; the metric side closes in E1).

Do: add the P2 fields from §4 to `packages/agent-models/src/lib/trace.ts` and pass them at the trace sites in `packages/agent-core/src/lib/loop/loop.ts` (`executeReadyCall`, the batch path in `executeReadyBatch`, and `manageResidency` for eviction and in-run compaction, which already return `toolCallIds`).

Accept: a fresh run's trace has `toolCallId` on every `tool_start`/`tool_complete`, and `toolCallIds` on each `context_evicted`; old traces still parse; workspace typecheck and the 38 agent-core tests pass.

### E0 — Readers (free)

Closes: F3, F12. Relies on R1, R5.

Do:
- `readCatalog(home)` → threads with `parentThreadId`, `parentRunId`, `subagentProfile`, `kind`, `workspaceRoot` (G1).
- `readRunTrace(file)` → `{ lines: TraceLine[], warnings: number }`: corrupt lines skipped and counted, unknown types kept as-is, never throws.
- `readLedger(home, threadId)`, `readUsage(home)`.
- `listRuns(home, { threadId?, since? })` → `RunSummary[]`, built from `run_start`, `run_finish`, `last-run.json` and the catalog; child runs nested under their parent by `parentRunId`. **RunSummary is the only join point**; the viewer and later stages use it.
- CLI `runs`: table of runId, thread, model, depth, status, limitReason, iterations, tool calls, prompt tokens own/children, duration.

Accept:
- Typecheck and parser tests pass.
- `npx nx run @agent/agent-eval:runs -- --home .local/personal-assistant --thread 5255ff5c-e4a6-4199-a3b8-3a4388504285` shows run `d8d1e745…`: `incomplete`, `limit.tokens`, 77 iterations, ~2.5M prompt tokens.
- A fixture with a corrupt line loads with `warnings: 1`.

### E1 — Metrics (free)

Closes: F11 (metric side). Relies on R2, R7.

Do: `computeRunMetrics({ lines, ledger?, usage? }): RunMetrics` (pure), `computeThreadMetrics`, CLI `metrics --run | --thread | --since [--json]`.

| Metric | Source |
| --- | --- |
| Prompt tokens per call: median, p90, max | `llm_response.usage.promptTokens` |
| Totals, prompt:completion ratio, child share | `run_finish.usage` (`own`, `children`) |
| Iterations; tool calls by name and by stage | `llm_response`, `tool_start` |
| Wall clock; answer-writing time vs whole run | `run_finish.durationMs`; ledger `durationMs` / `runDurationMs` |
| First successful edit: iteration, tokens before it | first `edit_file` `tool_complete` with `Created`/`Patched` |
| Idle share | prompt tokens before first edit ÷ total (1.0 when no edit) |
| Read walks | runs of ≥5 consecutive `read_file` calls on one path with `limit` < 40 |
| Re-reads after eviction | `recall` calls, plus `read_file` of a path whose call id was in `toolCallIds` of an earlier eviction (needs P2; reported as `null` on older traces) |
| Steering | counts of `stall_nudge`, `research_gate`, `tool_note`, `budget_warning`; `limit` reasons |
| Reasoning effort | distribution of `llm_request.reasoningEffort` |
| Capacity | `usage.jsonl` balance delta per run; aggregate "% weekly per 1M prompt tokens" per model |

Accept:
- For `d8d1e745…`: 0 edits, idle share 100%, one read walk of 14 calls on `apps/web/src/app/themes.css` (iterations 64–77), 25 network calls (`web_search` 6 + `web_fetch` 19), re-reads `null` (pre-P2 trace). (Measured 2026-10-31; earlier "~15 / ~30" were hand estimates.)
- `--json` output type-checks against the exported `RunMetrics` (a small fixture file compiled in the parser test).

### E4a — Viewer over free data

Relies on R1 (`seq` anchors).

Do: `apps/eval` (Next.js, matching `apps/web`), server components importing `@agent/agent-eval`; no parsing in the app.

| Route | Shows |
| --- | --- |
| `/` | Threads (catalog) with last status, model, kind |
| `/threads/[id]` | Runs, child runs nested |
| `/runs/[runId]` | Iteration timeline: model calls (tokens, duration, effort), tools (args preview, duration, result size), sub-agents inline, markers for evictions, in-run compactions, limits, stall nudges, research gates, budget warnings; metrics panel |
| `/usage` | Capacity over time from `usage.jsonl` |

Every timeline event anchors as `#seq-<n>`: the sink's `seq`, or the 1-based line number for traces written before `seq` existed (`d8d1e745`'s second eviction is `#seq-278`).

Accept:
- `npx nx run @agent/eval:build` passes.
- `/runs/d8d1e745…` shows 77 iterations, eviction markers at iterations 25 and 61, and the `limit.tokens` end; `#seq-<n>` of the second eviction scrolls to and highlights it.

### Checkpoint — one week of use (free)

Closes: F16, F17 (measurement side).

Use `metrics` and the viewer on normal work. Record in this doc: the top three wastes by tokens, the observed "% weekly per 1M tokens" per model, and which harness steering signals fired. This decides the first tasks and the eval budget for E2.

### E2 — Task suite and runner (spends capacity)

Closes: F13, F15, F17 (ceiling), F14 (seed side). Relies on R3, R4, R6.

Do:
- **Task schema** (`evals/tasks/<suite>/<id>.json`): `{ id, suite: 'regression' | 'capability', repo: { source, commit }, prompt, posture, checks: [{ run, expectExit, timeoutSec }], files: [{ path, mustMatch }], scope: { allow: string[] }, budget: { maxPromptTokens, maxMinutes } }`.
- **Seed** (`agent-eval seed`): build `.local/eval-home` from the personal home: copy `skills/` and `agents/`, and a frozen copy of memory files. Write `seed.json` with a content hash. Without this, evals measure a different agent than the one you use.
- **Checkout**: `git worktree add` at `repo.commit` into `.local/eval-home/workdirs/<task>-<n>`. Link the main checkout's `node_modules` when the pinned `package-lock.json` matches the current one; otherwise run `npm ci` and record the extra time. Prune old workdirs at start.
- **Runner** (`agent-eval run --task <id> --repeat 1`): require a running API with `AGENT_HOME=.local/eval-home` (refuse otherwise; never start it). Per trial: capacity check (`GET /usage/balance`; skip with `skipped: capacity` if the governor would pause) → create a workspace thread on the workdir → `POST /run` → wait for SSE `run.settled` → send "Continue from where the last run stopped." up to 2 times on resumable limits → grade → write the result.
- **Grading, cheapest first**: checks (exit codes, run in the workdir after the trial), file assertions, scope (`git diff --name-only` ⊆ `scope.allow`), budget (tokens, minutes, no unresolved `limit.*`). Attach E1 metrics for diagnosis only.
- **Result**: `{ taskId, suite, trial, harnessSha, seedHash, taskHash, model, status, checksPassed, filesPassed, scopeViolations, budgetOk, continues, limitReason?, metrics, threadId, runIds }`.
- **Suite budget**: `--max-weekly-percent <n>` (default 10), estimated from the checkpoint's "% weekly per 1M tokens"; the runner stops before exceeding it.
- **First tasks**: 5, drawn from the checkpoint's real wastes and from real work (theme change, sub-agent bug fix, docs edit, small refactor, plan-only request). Prefer checks that finish in seconds (one project's typecheck, file assertions) over full builds. Migrate `apps/agent/src/eval` Home Q&A scenarios as `capability` tasks; their transcript graders become E5 rubric checks. Delete the old in-process eval after the migrated tasks run once (it calls `runLoop` directly, against G2).

Built with: `.local/eval-home` seeded via `agent-eval seed` (200 files); the runner verifies the API serves the eval home by creating and deleting a probe thread. Home Q&A migration is **deferred**: the runner drives workspace threads only; `apps/agent/src/eval` stays until home tasks are supported.

Accept:
- One task runs three times (`--repeat 3`) and writes three result files with `harnessSha`, `seedHash`, `model` filled.
- A deliberately failing check marks the trial failed; the runner continues.
- With the API not running, or pointed at another `AGENT_HOME`, the runner refuses with a clear message.

### E3 — Baselines and gate (spends capacity)

Closes: F8, F9, F10, F14 (gate side).

Do: `agent-eval baseline --suite regression [--accept "<reason>"]` and `agent-eval gate --suite regression`, with the rules in §8. The gate prints a per-task diff table and exits 1 on failure.

Accept:
- Gate passes against a fresh baseline.
- A hand-edited baseline number fails with a readable reason.
- A different model, seed hash or task hash makes the gate refuse; a different `harnessSha` does **not** (that is what it tests).

### Later stages (plan when the checkpoint data says they are worth it)

- **E4b** — viewer tabs: suite results, gate diffs, A/B compare (same task shape only; cross-thread compare is labelled "diagnosis").
- **E5** — offline judge: pairwise first, rubric second; judge model ≠ agent model; calibrate on a human-reviewed sample before it may gate.
- **E6** — analyst (closes F4): `AnalystReport` type lives in `report.ts`, `generate.ts` imports it; offline report over N failing traces; every claim cites `runId` + `seq` (rendered as viewer links); never read by the gate (import-graph separation, proven by "gate exit code unchanged with a report present").

## 7. Grading ladder

1. End-state checks (commands, in the workdir after the trial). Primary grader.
2. File assertions.
3. Scope (diff ⊆ allowed paths).
4. Budget (tokens, minutes, unresolved limits).
5. Pairwise judge (E5, optional; better at "which is better" than absolute scores).
6. Rubric judge (E5, optional; only without a baseline).

Grade the outcome, not the path: a run that says "done" with wrong files fails; a run that took an unexpected route to correct files passes.

## 8. Statistics and gate rules

- **Trials**: `--repeat 1` while a task is new; 3 once it is stable; 5 for tasks near a threshold.
- **Report**: pass@k (at least one of k passes) and pass^k (all k pass), token medians, spread (max ÷ min tokens).
- **Unstable tasks**: spread > 2× → flagged; excluded from the token rule; cannot gate until stable.
- **Gate fails when** (regression suite only):
  - a task loses ≥ 2 passing trials out of 3 (or ≥ 2 of 5), or
  - the suite pass rate drops by more than 10 points **and** at least 2 trials were lost suite-wide (in a small suite one flipped trial is already >10 points), or
  - median prompt tokens rise > 10% on a stable task that passed in both baseline and candidate, or
  - scope violations rise on any task.
- **Gate refuses** (exit 2, no verdict) when model, `seedHash`, or a `taskHash` differs from the baseline. `harnessSha` is recorded for attribution, never a reason to refuse.
- **Baselines** are written only by `baseline`: after a passing gate, or with `--accept "<reason>"` for an intentional trade-off (the reason is stored in the file).
- **Capability suite** never gates; a task passing 3/3 in three consecutive suite runs graduates to regression.

## 9. Improvement loop

```
baseline → one harness change → run suite → gate
   pass → merge, re-baseline
   fail → open failing trials in the viewer → find the first wrong decision
        → fix the owning layer (limits, context, tools, gates, prompts, model map)
        → re-run the affected tasks, then the full suite
   every new failure class → becomes a task
```

Triage by class, not case: many `limit.tokens` → budget/limits; long read walks or high idle share → context/tools; scope violations → gates/registry; passes at 2× tokens → residency/compaction regression. One harness change per suite run, or the result is unattributable.

## 10. Capacity

- S0–E1, E4a and the checkpoint cost nothing (they read existing files).
- Before E2, compute the suite estimate: tasks × trials × median tokens × "% weekly per 1M". Default ceiling 10% of the week per suite run.
- The governor applies to eval runs too (they go through the API), and the runner checks capacity before each trial.

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Code written against imagined fields | G6; P-steps add fields first; typecheck is a real Nx target (S0) |
| Evals measure a different agent | Seeded eval home with `seedHash`; gate refuses on mismatch |
| Checkouts pollute the Nx graph | Workdirs under gitignored `.local/eval-home` |
| Noisy gate | Trial-count rules, stable-task filter, suite-level threshold |
| Draining the weekly allowance | Free stages first; suite ceiling; per-trial capacity check |
| Viewer drifts into a second reader | Server components import `@agent/agent-eval` only |
| Analyst creeps into gating | Deferred to E6; import-graph separation and its acceptance test |

## 12. Sources

- Anthropic, *Demystifying evals for AI agents* (Jan 2026) — https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents (task/trial/transcript/outcome; grade outcomes; capability vs regression and graduation).
- Anthropic skills, *Building an Eval for a Claude-Powered Application* — https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/evals/build-eval.md (grading ladder; 15–100 tasks; real entry point; isolated environment).
- Anthropic docs, *Define success criteria and build evaluations* — https://platform.claude.com/docs/en/test-and-evaluate/develop-tests (task-specific; automate; volume; judge with a different model).
- OpenAI, *Evaluation best practices* — https://developers.openai.com/api/docs/guides/evaluation-best-practices (eval-driven development; log mining; pairwise judging; calibrate against humans).
