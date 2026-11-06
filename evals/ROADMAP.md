# Evals roadmap (v2, simplified)

2026-11-05, branch `evals` (HEAD `9065479`, not pushed; `ce98f10` pushed). v1 was reviewed with the `ponytail` and `karpathy-guidelines` skills, and this version keeps only what a phase needs to work and to be checked. Rationale for the designs lives in `evals-deepening.md`; this file is the plan of record.

**Out of scope by decision:** candidate 4 (capacity rule), so the suite ceiling only understands legacy session/weekly plans.

## Thesis

1. **Evals decide, not feel.** Gate on end-state outcomes.
2. **Trust before spend.** A trial is graded only after its run settled; runner logic is tested offline first.
3. **Core states facts once.** The trace carries what core decided; the eval reads it, never re-derives it.
4. **See every call.** Any model call can be opened: what went in, what came out.
5. **A skip defers, it doesn't stop.**

## Rules for every phase

- Each phase is one harness run, finished with `npx nx run-many -t typecheck,test,build -p <projects>` and `npx eslint <paths>`. Update the status table.
- Every changed line traces to the phase's goal. No refactors next door.
- After phase 2, a `loop.ts` change must pass the replay, or change its snapshots only as the phase intends.
- No push, PR or branch deletion without your OK. Keep `evals-backup-2026-11-04`.
- agent-eval depends on agent-models only. Trials go through the HTTP API. New trace fields are optional, and old traces must still read.

## Status

| # | Phase | Projects | Spends | Needs | State |
|---|---|---|---|---|---|
| 0 | Housekeeping | repo, web | no | — | done except the push (git not used, by your instruction) |
| 1 | Skip-to-defer | agent-core, agent-models | no | — | done (in-app check pending) |
| 2 | Replay snapshots for the loop | agent-core | no | 1 | done |
| 3 | Runner correctness | agent-eval | no | 0 | done |
| 4 | Trace facts + call recording | agent-models, agent-core, api, agent-eval | no | 2 | done |
| 5 | Breakdowns + `analyze` | agent-eval | no | 4 | done |
| 6 | Viewer: hierarchy + call inspector | eval | no | 3, 4, 5 | done (checked in a browser) |
| 7 | Suite + first live baseline | evals/ | yes | 3 | tasks done; live run not started (needs the API and your OK to spend) |
| 8 | System 1 health, then shadow, then A/B | api config, evals | yes | 5, 7 | not started (needs live use) |
| 9 | Improvement loop: one gated harness change at a time | whichever module owns the area | yes | 5, 7 | ready: `analyze` ranks the areas |

**Already done** (2026-11-04/05, commits `ce98f10` and `9065479`):
- the main → evals merge
- run statuses `cancelled` / `interrupted` and `stopLabel`
- the Continue rule from the shared limit helpers, and capacity pause → `skipped`
- waiting for `run.settled` only, and settling after a timeout cancel
- `thinking` on tasks and `--thinking`
- `system1Setup` on trials; the gate refuses across setups unless `--compare system1`
- System 1, memory-gate, skills, prefix-heavy and thread-compaction metrics
- viewer rows for the new events
- 17 tests

There are two tracks with no shared files: core (1 → 2 → 4) and eval (0 → 3). They join at 5. Phase 7 can start right after 3.

---

## 0. Housekeeping

1. Push `9065479`. **Needs your OK.**
2. Copy this file to `evals/ROADMAP.md` so it's tracked. The other docs stay local scratch, because this file is self-contained.
3. Add `passWithNoTests: true` to `apps/web/vitest.config.mts`.

**Verify:** `npx nx run-many -t test` exits 0.

## 1. Skip-to-defer

**Change** (`loop.ts`, `offer-choice.ts`, `prompts/system-prompt.ts`, comments in `choice.ts`, `loop/types.ts`, `runs.routes.ts`):
- `finalizeWithoutTools` takes the instruction text as a parameter.
- On a skip:
  - **First answer every call of the turn:** `record.skip(turn.toolCalls, 'Skipped: user deferred this choice.')`.
    - Today a `delegate` queued after `offer_choice` gets no row, because `offer_choice` has no stage, runs as `mutate`, and the subagent stage never starts.
    - With a model call added, that unanswered `tool_calls` entry would be sent to the provider.
  - Call `finalizeAnswer` with the deferred-choice instruction. It asks for: what was done, the open question, each option with its trade-offs, a recommendation, and how to reply.
  - Emit `turn.completed` and `run.completed` (no `incomplete`), as `completeAfterLimit` does, and return `completed`.
  - A cancel during the summary ends as `cancelled`. The options and the skip stay in the ledger.
- Delete `finishChoiceSkipped`.
- Every copy of "if they skip, stop" changes, so the summary call doesn't read "Stop." in its own history:
  - `USER_SKIPPED_CHOICE`
  - `system-prompt.ts:85`, `:203`
  - `offer-choice.ts`
  - comments in `choice.ts`, `loop/types.ts`, `runs.routes.ts`

**Tests** (`loop.choice.test.ts`, scripted model):
1. A skip leads to exactly one more call, with an empty tool registry, and the result is `completed` with that text.
2. A sibling `delegate` in the same turn is recorded as skipped, and every `tool_call` id has a row.
3. The instruction is never passed to `onMessage`.

**Verify:** the 3 tests pass. In the app, a skip gives a summary message with no incomplete notice, and "go with B" continues.

## 2. Replay snapshots for the loop

**Change:**
- `loop/replay.test.ts` with six scripted scenarios:
  1. plain answer
  2. parallel reads then an edit
  3. a `limit.tokens` stop with its handoff
  4. eviction
  5. cancel mid-batch
  6. choice skip
- Each scenario records trace lines and events, with `ts`, ids and durations normalised, and compares them with `toMatchFileSnapshot`. Vitest's own `-u` updates the snapshots, so no golden-update script is needed.

**Verify:** reordering two trace calls in `loop.ts` fails the test, and reverting the reorder passes it.

## 3. Runner correctness

**Change** (agent-eval only):
- **Settle check:** `ApiClient.settledLastRun(threadId, runId, timeoutMs)` polls `GET /threads/:id/ledger` every 2 s until `lastRun.runId === runId`.
  - That alone is the signal, because the API hides `lastRun` while the run is live.
  - The ledger response is typed with `LedgerResponse` (today it's wrongly typed as `activeRunId`), and the run request with `StartRunRequest`.
- **Why the trial ended:** `TrialResult.ended: 'settled' | 'timeout' | 'cancelled' | 'capacity' | 'error'`. The viewer grid and the suite report separate "the agent failed" from "the infrastructure failed".
  - `runTrial` calls it after every `waitForRun` result (`settled`, `cancelled`, `gone`). So a dropped stream can no longer cause a live workspace to be graded.
  - `ponytail:` it polls the whole ledger; add a status route if trials ever get slow.
- **Choices:** nobody answers `offer_choice` over HTTP, so today a trial with a question blocks until its deadline.
  - The poll sees `activeRun.pendingChoices` and posts `{ skipped: true }`.
  - With phase 1 that gives the summary and `completed`. The grade then says whether asking instead of acting was right for the task.
- **Testable trial:** export `runTrial` and give it the client as a parameter (`TrialClient`, the 5 methods it calls plus `settledLastRun` and `skipChoice`). There are two adapters: `ApiClient`, and a fake in tests.
  - The fake writes trace files in the agent-home layout, because `runTrial` also reads traces, checks out with git and grades on disk.
- **Prune:** match `^<task>-\d+$`.
- **Suite meta:**
  - Write `summary.json` at the start and again at the end, without the results copy (the trial files are the one copy).
  - Add `readSuiteRun(dir) → { meta, results }`. `readResults` stays as is.
- **Gate order:** `baseline` reads and verifies the baseline before running anything. `gate` already does.
  - `summarizeSuite` refuses trials from mixed suites (`TrialResult.suite` exists) and sets `SuiteStats.suite`.

**Tests:**
1. Completes.
2. `limit.tokens` → Continue → completes.
3. `limit.capacity` → skipped, and the suite stops.
4. Timeout → settles → graded with `eval.timeout`.
5. Timeout → never settles → `error`.
6. `gone` while the run is still live → waits, then grades.
7. A pending choice → skipped, the run completes, the trial is graded.
8. Prune keeps `readme-glossary-1` when pruning `readme`.
9. `summarizeSuite` refuses mixed suites.

**Verify:** the 9 tests pass offline.

## 4. Trace facts + call recording

**Trace fields** (all optional):
- `tool_start.stage`, from the loop's own `toolStage(tool)` (one line).
- `run_finish.cancelled`, when the signal was aborted (one line).
- `tool_complete.outcome: 'ok' | 'error'` and `exitCode`, from a new optional `Tool.classify(result)`, called on the shaped result in `settleReturned`. Shaping only caps the tail for these two tools, so this is safe.
  - **`edit_file`:** `classify` becomes the one copy of "edit applied". The loop's two `isEditSuccess` uses (`loop.ts:465`, `:895`) call it, and `isEditSuccess` is deleted.
  - **`run_terminal`:** reads `exit <n>`, `exit timeout` and `signal X` from its second line. A non-zero exit keeps `outcome: 'ok'`, because a failing test is often the point; the analysis reads `exitCode`.
  - **Trace only:** the ledger, the web and `ToolOutcome` don't change.

**Call recording, on the lines the loop already writes** (no new event type, no wrapper):
- **Finals:** `finalizeAnswer` now traces `llm_request` / `llm_response` too, with `final: true`.
  - Today the tools-off finals are invisible, so per-call tokens never add up to the run total.
  - This is an intended replay snapshot change (scenarios 3 and 6).
- **Input refs:** when `config.recordCalls` is true, `llm_request` gets `input`: `{ tools: { sha, names } | null, messages: { role, sha, chars, toolCallId?, toolCallIds? }[] }`.
  - The sha is `sha256Text(JSON.stringify(message))`, taken synchronously before the call; the loop replaces slots but never mutates a sent message.
  - Each message JSON and the tool definitions are written once per run through the existing `config.putBlob`. The written shas are memoised, and errors are swallowed, so recording never fails a run.
- **Output ref:** `llm_response` gets `output: { sha }`, the assistant message as sent back, stored the same way.
- **Wiring:**
  - `start-run.ts` sets `recordCalls: true` unless `AGENT_RECORD_MODEL_CALLS=0`.
  - Sub-agents inherit it through `SubagentParent` (they already get the child thread's `putBlob` and trace).
  - Not wired in `local-run.ts`, which has no blob store.
- **Hashing:** move `sha256Text` from `tools/web/source.ts` to a shared core util. It already matches `ThreadStore.putBlob`'s sha.

**Eval side:**
- `read/calls.ts`, the only module that knows the blob layout. The viewer never reads blobs itself, and shas are validated as `^[0-9a-f]{64}$`.
  - `listCalls(lines)` returns the call list from the trace.
  - `readCall(home, run, n)` returns the input messages, the output, the diff against call n-1 by sha, and tokens by kind.
- **Message kinds:**
  - `system`: role system.
  - `tool`: matched to its ledger row by `tool_call_id`; `stub` when the sent content differs from the row's full content (the blob, when the row was offloaded).
  - `assistant`: matched by `tool_call` ids or content.
  - `user` / `injected`: a user-role message whose text matches no ledger user row is `injected`.
  - `rewound`: the run's rows are no longer in the ledger, so nothing is labelled injected.
- **Metrics:** read `stage` and `outcome`, and fall back to the copied table and `isEditSuccess` copy for old traces.

**Tests:**
- Scripted loop with `recordCalls` and an in-memory `putBlob`: the messages rebuilt from blobs **equal** the array the fake model received (the fake copies it on receipt), and the final call has `tools: null`.
- `classify`, for edit_file and run_terminal.
- `readCall` fixtures: stub, injected, rewound, diff.

**Verify:** the tests pass. In a real run, every model call, including the final one, can be rebuilt.

## 5. Breakdowns + `analyze`

**Change:**
- `read/iterations.ts`: `iterationsOf(lines)` is the one place iteration boundaries are computed. Each entry has the request, the response, the tool calls with their outcomes, the markers, and the final flag. The metrics and the viewer tree both read it.
- Add to `RunMetrics`, computed from `iterationsOf`:
  - phase split (tokens to the first edit, to the last edit, after)
  - iteration shape (0, 1 or 2+ calls; plan-only)
  - prompt growth (last ÷ first)
  - first-call layers
  - model time vs **tool-seconds** (labelled, because parallel tools overlap)
  - tool outcomes per tool (from phase 4)
- `analyze --since | --thread | --results [--json]` prints one row per area: runs affected, tokens in those runs, worst signal, owning module.
  - The thresholds are one `const` table in `metrics/areas.ts`, with each area mapped to its owner.
  - It then lists the top 10 runs by tokens, each with its signals.

**Trust check:** `memory_gate` read 0 lines over 198 real runs.
- Before the memory row is shown, find out whether the memory tool was really unused or the gate isn't traced on that path.
- If it isn't traced, fix the trace line. If it was unused, the row shows "no memory writes".

**Tests:** one fixture per new metric, and one test that the thresholds fire.

**Verify:** `analyze --since 2026-10-25` reproduces the hand-computed numbers: 66% one-call iterations, median growth 2.3×, conversation 72% of the first call. These are old traces without finals, so their shares are labelled "finals not traced".

## 6. Viewer: hierarchy + call inspector

**Pages:**
- `/results`: one row per suite run, from `readSuiteRun` over `<eval home>/results`. The eval home comes from `EVAL_HOME`, else `.local/eval-home`. It's separate from `EVAL_AGENT_HOME`, which the run pages already use for real-use runs.
- `/results/[id]`: a task × trial grid. Each cell shows its four grade parts and why the trial ended, with the area rows below.
- `/runs/[id]`:
  - **Left:** the iteration tree as native `<details>` nodes, grouped in phase bands. Each row has the effort level, a prompt-size bar and tool chips coloured by outcome; sub-agent runs nest inside.
  - **Right:** the inspector, selected with `?call=n` or `?tool=id`.
    - **Input:** a stacked token bar by kind, then the messages, each expandable.
    - **Output.**
    - **Diff.**
  - Runs recorded before phase 4 show "input not recorded".
  - The tree reads `iterationsOf`, and the inspector reads `readCall`. Pages never parse traces or touch blobs.
  - **Lookup:** the run page finds its run with `readRun(home, runId)`, which locates `<runId>.jsonl` from the directory listing and parses only that thread and its sub-agent threads. Today `findRun(await listRuns(home), runId)` parses every trace in the home on each page load, and the inspector would make that cost visible.
- Server components and plain CSS only. One colour per message kind: system slate, tools indigo, conversation sky, tool results teal, injected amber.

**Verify:** `@agent/eval:build`. In a browser, get from `/results` to one tool call in five clicks, and see a replaced message in the Diff tab of a run with an eviction.

## 7. Suite + first live baseline

**Change:**
- Re-pin `readme-glossary` to a commit with the current lockfile, so `node_modules` links and `npm ci` is skipped.
- Add 2 regression tasks, each with checks under 30 s:
  - a small bug fix whose failing test must pass
  - an `ask` lookup with `scope.allow: []`
- Seed, then start the API on the eval home.
- `run --suite regression --repeat 3 --label merged`, then `baseline`, then commit `evals/baselines/regression.json`.
- Run `analyze --results <id>` and record the area rows in this file.

**Cost:** 3 tasks × 3 trials, at roughly 300k tokens per trial, is about 2.7M tokens, about 3% of the week on glm-5.3.

**Verify:** a committed baseline and its recorded area rows.

## 8. System 1 health, then shadow, then A/B

1. **Health:** find why the breaker opens (315 of 485 fallbacks) and the timeouts (152). Set `SYSTEMONE_TIMEOUT_MS` just above the measured p95.
   - **Gate:** fewer than 10% fallbacks over a day of normal use.
2. **Shadow week:** `SYSTEMONE_MODE=shadow`. Tune the thresholds against what happened next (tool errors, failed edits, using phase 4's outcomes).
3. **A/B:** `gate --compare system1` with `--thinking auto` in enforce against the phase 7 baseline. Promote only if the pass rate holds and tokens drop.

**Verify:** a recorded promote/no-promote decision with its gate output.

## 9. Improvement loop (ongoing)

**Loop:**
1. Run `analyze` on real use and on the suite.
2. Pick the area with the most tokens in affected runs.
3. Make **one** change in the module that owns it.
4. Run `gate` against the baseline.
5. If it passes, keep it and re-baseline. If it fails, find the first wrong decision in the viewer and fix it, or drop the change.

One change per gate run, or the result can't be attributed.

**Scoreboard** (targets from the harness plan; `analyze` reports each one):

| Metric | Target |
|---|---|
| First-call prompt | ≤ 20k tokens |
| Median prompt per call | ≤ 45k |
| Prompt tokens per task | −70% vs the first baseline |
| Prompt : completion | ≤ 150 : 1 |
| Pass rate | ≥ baseline (never traded for tokens) |
| Edits outside scope | −50% |

**Backlog, ordered by what the real data shows** (each one is gated, never merged on belief):
1. **Batch independent reads** (66% of iterations make one tool call). Prompt guidance first, a loop nudge if that fails.
2. **Read whole small files by default** (read walks).
3. **Search exact user-visible strings first** for "what does this message mean" questions.
4. **No plan-only iterations** (53 seen): tick plan steps alongside real calls.
5. **Re-read before editing** (`edit_file` misses 6%): `oldText` not found means a stale read.
6. **Context growth on long runs** (p90 11.5×): compaction and eviction timing in `context/`.
7. **System 1 sites after phase 8:** a final-answer check against unverified "done", a quick-lookup step cap, scoring while tools run, and Auto for sub-agents.
8. **No generic "senior engineer" persona line.** If anything, add two or three concrete behaviours the logs show the model skipping, and gate them.

---

## Cut from v1, and when to add back

| Cut | Why | Add when |
|---|---|---|
| `EvalHome` class (7 methods), `SuiteRunWriter`, `meta.json`, shared home resolver | The two real bugs (prune, unused summary) are a regex and a read. The class abstracts a folder only the runner writes | A second writer of the eval home appears |
| `AgentPort` as a new interface with SSE resume-from-seq | The existing client plus a ledger poll fixes the bug; resume code is a second state machine | Trials need sub-second settle detection |
| `run-gate.ts` with thunks | Moving the baseline read before the run is 3 lines in the CLI | The gate gets a second caller |
| Usage-row wait after a trial | Per-trial capacity is noise; capacity rates come from many usage rows | Never, unless per-trial cost is gated |
| `ToolOutcome 'error'` in the ledger and web, classifiers for `recall` / `delegate` | Evals need it in the trace only; the UI never asked | The UI wants to mark soft failures |
| Diagnosis module with `Finding` type, "tokens lost" attribution, evidence anchors | A threshold table plus one CLI table answers "which area"; attribution is guesswork | Areas tie and need a finer ranking |
| Steering-effect and System 1 lowered→error metrics in phase 5 | Only phase 8 uses them | Phase 8 |
| Replay: about 20 scenarios and a golden-update script | Six scenarios cover what the planned loop changes touch; vitest has file snapshots and `-u` | A loop change touches an uncovered path |
| Viewer `/compare`, sparkline, Tokens tab | `gate` already compares per task; the iteration bar shows growth; the token bar sits in Input | Phase 8 A/B review needs side by side |
| 5 regression + 2 capability tasks | 3 regression tasks are enough for the gate's trial rules and cost about 3% of the week | `analyze` shows a waste class worth its own task |
| D12 before/after on the old harness | A retrospective with real setup cost (old API in a worktree) | The merged baseline looks worse than personal-use metrics |
| Retiring `apps/cli/src/eval` | It isn't run and doesn't block anything | A home-thread task is needed |
| Investigating cached-prompt tokens | Open question, no consumer yet | Phase 8 needs the cache answer |
| Quick-pick chips under a deferred-choice summary | Typing "go with B" already works | Deferred choices become frequent in `analyze` |

## Architecture review changes (v2.1, 2026-11-05)

A fresh-context review checked every phase against the code. Adopted:

| Change | Phase | Why |
|---|---|---|
| A skip answers every `tool_call` of the turn before the summary | 1 | Queued `delegate` calls got no row; a model call would then send unanswered `tool_calls` |
| Change every copy of "if they skip, stop" (5 places) | 1 | The summary call would read "Stop." in its own prompt |
| Record call inputs on `llm_request` / `llm_response` and trace finals; drop the decorator and the `llm_call` event | 4 | Iteration is already known there; no seq pairing, no duplicated usage; finals become visible |
| Reuse `config.putBlob`; no new `putText` port | 4 | One copy |
| `Tool.classify` replaces `isEditSuccess` in core | 4 | One copy of "edit applied" |
| Match tool rows by `tool_call_id`, not sha; add a `rewound` label | 4 | Ledger shas cover offloaded tool content only, and rewinds truncate rows |
| The runner skips pending choices | 3 | Trials with a question hung until their deadline |
| Settle = `lastRun.runId === runId` | 3 | The API hides `lastRun` while the run is live |
| `iterationsOf` shared by metrics and viewer | 5, 6 | One copy of iteration boundaries |
| Label tool time "tool-seconds" | 5 | Parallel tools overlap |

Considered and not adopted now:

| Idea | Why not now | Revisit when |
|---|---|---|
| One loop finisher for the 7 run-ending blocks | A real deepening, but a refactor next to phase 1, not part of it | After phase 2's snapshots exist, as its own change |
| A canonical message serializer in agent-models | `JSON.stringify` / `JSON.parse` already is one | Messages get a non-JSON form |
| Pausing before the summary call when capacity is spent | The limit handoff doesn't check either; keep the two the same | Capacity pauses show up in deferred summaries |

## Decision register (final, 2026-11-05)

Each candidate is judged on three questions: is the problem real (evidence), does the code support the proposed seam, and is it the simplest version that solves it. This table is the record; the phases above implement it.

| # | Candidate | Real problem? (evidence) | Code check | Decision | Where |
|---|---|---|---|---|---|
| R1 | Trial module behind an agent port | Yes: a closed stream is graded as finished; questions hang trials; runner untested | `runTrial` unexported, uses 5 client methods | **Adopt, minimal.** Inject the existing client (two adapters: HTTP, fake). No new port module | 3 |
| R2 | Eval-home module | Partly: the prune prefix bug is real; layout knowledge is spread but only the runner writes it | `checkout.ts:53`; `summary.json` never read | **Adopt the fixes, reject the class.** Prune regex, `readSuiteRun`, meta in `summary.json` | 3 |
| R3 | Trace states facts | Yes: drifted stage table; `edit_file` 6% and `run_terminal` 23% failures invisible; 24 of 27 "errors" were cancels | `toolStage` and the abort signal are in the loop; results are shaped before tracing | **Adopt.** `stage`, `cancelled`, `Tool.classify` for 2 tools, trace only | 4 |
| R4 | Capacity rule in agent-models | Only on USD plans, which aren't in use | — | **Excluded** by you | — |
| R5 | Gate checks before it spends | Yes, for `baseline` only (`gate` already reads first) | `cli/gate.ts:62` | **Adopt, minimal.** Move the read; suite check in `summarizeSuite` | 3 |
| R6 | Fold the CLI eval into tasks | No: not run, not blocking | — | **Defer** | — |
| A1 | Record calls on the existing trace lines | Yes: your requirement to see every call; finals are untraced today | All calls of a run pass the loop's two call sites; `putBlob` exists | **Adopt.** Replaces the decorator and the new event | 4 |
| A2 | A skip answers every call of the turn | Yes: `delegate` after `offer_choice` gets no row | `offer_choice` has no stage → mutate; subagent stage never starts | **Adopt (required by phase 1)** | 1 |
| A3 | One copy of "what a result means" | Yes: `isEditSuccess` in core plus a copy in the eval | `call-identity.ts:100`, `run-metrics.ts:119` | **Adopt, merged into R3** | 4 |
| A4 | Trial owns settle and choices | Same as R1 | `lastRun` hidden while live (`run-context.ts:256`) | **Adopt, merged into R1** | 3 |
| A5 | `iterationsOf` and `readCall` | Yes: metrics, phase split and the viewer all need iteration boundaries; blob layout must have one reader | — | **Adopt** | 5, 6 |
| A6 | One loop finisher for 7 endings | Real, but no phase needs it | 7 `run.completed` blocks in `loop.ts` | **Defer.** Do it with the next change to how runs end, after phase 2's snapshots exist | — |
| U1 | Skip defers instead of stopping | Yes: your decision; the "incomplete, no reason" runs | `finalizeWithoutTools` reusable once the instruction is a parameter | **Adopt** | 1 |
| U2 | Hierarchy viewer and call inspector | Yes: your requirement | Needs A1 and A5 | **Adopt, lean** (no `/compare`, no sparkline) | 6 |
| U3 | Breakdowns by area | Yes: your requirement; real numbers already computed | Metrics stay one pure function | **Adopt, lean** (threshold table, no `Finding` framework) | 5 |
| U4 | Loop replay | Yes: no proof yet that loop changes keep traces | Scripted-model tests exist to build on | **Adopt, lean** (6 scenarios, vitest file snapshots) | 2 |

## How to work through it (recommended)

1. **Order:** 0 → 1 → 3 → 7 → 2 → 4 → 5 → 6 → 8 → 9.
   - Phase 7 moves up, right after the runner is correct (3). A real baseline early exposes runner problems against the real API while the changes are still small.
   - The gate compares outcomes and tokens, so phase 4's later trace additions don't invalidate the baseline.
2. **Each phase:**
   - Write the failing test first, then the change.
   - Run the phase's checks, then make one commit that names the phase and update the status table here.
   - Every changed line traces to the phase's goal.
3. **Stop rules:**
   - A verify step fails twice → stop and update this plan before going on.
   - A trace or event changes that the phase didn't declare → stop.
   - A phase grows past its file list → split it.
4. **Sessions:** one session in order is simplest and keeps the context. The eval track (3, 5, 6) and the core track (1, 2, 4) touch different files, so they can run in two worktree sessions if speed matters; merge the core track first.
5. **Your decisions along the way:**
   - OK to push after phases 0–1, 3 and 7.
   - OK to spend about 3% of the week in phase 7.
   - An in-app check of the skip summary after phase 1.

## Other open work (not eval work, kept so nothing is lost)

- **Manual app checks from the refactor:** reload mid-run, Stop then send-now, answer a choice after a reload, a web-heavy thread after compaction. Do them during phase 1's in-app check.
- Rename `@agent/agent-models` → `@agent/protocol` (undecided).
- Repo-wide prettier pass (own commit plus `.git-blame-ignore-revs`).
- F4: composer picker hooks out of `ChatInput`.
- One Agent-posture run per workspace folder (never existed).
- ADR 0001 (Playwright specs, then a loopback-only browser tool) is still Proposed.

## Implementation record (2026-11-05)

See `docs/plans/evals-implementation-report.md` for what was built, how it was verified, deviations and what is not done.

## Plan from here (2026-11-06)

This replaces the order of phases 7–9 above. Rule for every step from S3 on: one change per gate run, kept only if the pass rate holds and tokens drop.

| Step | What | Files or commands | Done when | Cost |
|---|---|---|---|---|
| S1 | Land what is built: one typecheck and test pass (the limit changes were never compiled), restart the API, in-app skip check, the manual checks from the refactor | `npx nx run-many -t typecheck,test,build` | All pass; a skip gives a summary; "go with B" continues | Free |
| S2 | First baseline (phase 7): seed, API on the eval home, suite × 3, record the baseline and `analyze` rows | `agent-eval seed`, `run --suite regression --repeat 3`, `baseline` | `evals/baselines/regression.json` exists; trials report `deps: linked` | Up to about 3% of the week |
| S3 | Batching guidance: batch independent reads and searches; update todos alongside real work | `prompts/system-prompt.ts` | Gate passes; one-tool share and plan-only count drop | Up to about 3% |
| S4 | Plan-only note: a `tool_note` when a turn only updates the plan (the gate behind S3's prompt) | `loop.ts`, `trace.ts` (`note: 'plan_only'`) | Gate passes; plan-only count near 0 | Up to about 3% |
| S5 | Checkpoint: a week of normal use with recording on | `analyze`, viewer | Top 3 wastes written here; disk growth from `blobs/` measured | Free |
| S6 | Long-run context: compaction and eviction timing, from what recorded runs show | `context/` | Gate passes; p90 prompt growth drops | Up to about 3% |
| S7 | Edit discipline: re-read before editing, check after the last edit | `prompts/`, maybe a tool note | Gate passes; failed edits and unchecked edit runs drop | Up to about 3% |
| S8 | System 1 health: why the breaker opens, timeout above measured p95 | `system1/`, `SYSTEMONE_*` | Fallbacks under 10% over a day of normal use | Free |
| S9 | System 1 shadow week, threshold tuning, then A/B with `gate --compare system1` | `SYSTEMONE_MODE`, `system1/effort.ts` | A recorded promote or no-promote decision | About 6% or more |
| S10 | Ongoing loop: `analyze`, top area, one change, gate; add a task when a waste class deserves one | Owning module | Scoreboard targets met | Per change |

**Picked up only when needed:** `parentToolCallId` on child `run_start` (exact sub-agent nesting), cached-token counts (before S9's prompt-cache question), one loop finisher (next change to how runs end), `/compare` page (if S9 needs it), retiring the old CLI eval, more regression tasks.

**Proposed targets for the new measures** (to confirm against the S2 baseline): one-tool iterations under 50%, plan-only near 0, failed edits under 3%, System 1 fallbacks under 10%.
