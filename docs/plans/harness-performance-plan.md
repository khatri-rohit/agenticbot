# Harness performance and sub-agent plan

Status: proposed, 2026-10-29. Supersedes the v1 `delegate` design from `ae56d90`.

## 1. Why this plan exists

The traces in `traces/` show where the harness spends:

| Run | Iterations | Prompt tokens, call 1 | Prompt tokens, total | Completion tokens |
| --- | --- | --- | --- | --- |
| 305d07c2 | 117 | 114k | 16.7M | 20k |
| 9f107e56 | 54 | 140k | 8.1M | 8k |
| 74924649 | 36 | 161k | 5.2M | 5k |

The model reads ~800 tokens for every token it writes. Single tool outputs are already capped (`WORKSPACE_READ_MAX_CHARS = 7_000` etc.), so the cost is accumulation: tool results inside a run are never evicted (`stubLiveToolResults` only stubs results from older user turns), and between-run compaction lets a thread fill to 65% of a ~200k window. Long context costs money, latency, and recall quality (context rot), which is where drift and off-task work come from.

The v1 sub-agent feature does not fix this, and has five correctness bugs (section 5, Phase 1).

## 2. Targets

Measured from Phase 0 traces on the same real tasks, before and after each phase. The Phase 7 app automates this later.

| Metric | Today | Target |
| --- | --- | --- |
| Prompt tokens, first call of a fresh workspace thread | ~114k+ | ≤ 20k |
| Median prompt tokens per call in a long run | ~140k | ≤ 45k |
| Total prompt tokens per eval task | baseline | −70% |
| Prompt : completion ratio | ~800 : 1 | ≤ 150 : 1 |
| Orphaned child runs after cancel | possible | 0 |
| Task success (end-state checks pass) | baseline | ≥ baseline |
| Edits outside the requested scope | baseline | −50% |

A phase that cuts tokens but drops task success does not ship.

## 3. Architecture invariants

These extend the five mental models in `README.md`. Every change in this plan must keep them.

1. **Tokens are the primary budget.** Iteration and tool-call caps stay, but a run is bounded by prompt tokens and wall clock. Children draw from the parent's pool.
2. **Stable prefix, batched eviction.** Prompt order is frozen system → tools → project rules → history → volatile layers → current turn. Eviction happens in large batches so the prefix stays cache-reusable between batches.
3. **Many readers, one writer.** Only the parent edits files. Children read, review, or advise. A future parallel writer needs its own git worktree and returns a diff.
4. **A child is a tool with a contract.** Typed brief in, typed report out, hard limits, cancellable, accounted. No child can ask the user, write memory, edit the plan, or spawn another child.
5. **Gate over prompt, for children too.** Child capabilities = profile ∩ parent registry ∩ posture − always-stripped. The model cannot widen them.
6. **One assembler, presets.** Parent and child prompts come from `assembleContext` with a preset, not hand-built strings in the host.
7. **Determinism stays.** Eviction and compaction are extractive. No LLM on the request path. Sub-agents are model calls the parent chose, not hidden host calls.
8. **Extension through providers.** Tools, agents, skills (and later MCP servers and plugins) register through one provider seam with a risk class, stage, output cap, and short guidance. Policy filters providers; nothing bypasses the registry or the gates.
9. **Measured or it did not happen.** Every model call reports usage and timing into a versioned trace; runs roll up child usage; harness changes show their before/after numbers (and pass the eval gate once Phase 7 exists).

## 4. Target shape

```
POST /run
  → prepareRun → assembleContext(preset: parent-workspace | parent-home)
  → RunManager.start({ budget, parent? })
      → runLoop
          ├─ ContextResidency.afterToolTurn(messages)      evict old tool results in batches
          ├─ RunBudget.charge(usage) / .check()             tokens, wall clock, iterations, tools
          ├─ tools (ToolRegistry from providers ∩ policy ∩ posture)
          └─ delegate → SubagentRunner (core)
                 ├─ AgentRegistry.get(profile)              explore | review | advisor | user-defined
                 ├─ capabilities = profile ∩ parent ∩ posture − stripped
                 ├─ assembleContext(preset: child-<context policy>)
                 ├─ RunManager.start({ parent: { runId, signal, budget, depth } })
                 └─ report → digest (≤1.5k tokens) + blob sha
```

New core pieces, each colocated with its owner:

| Piece | Home | Replaces / extends |
| --- | --- | --- |
| `RunBudget` | `agent-core/src/lib/loop/limits.ts` | `AgentLimits` (adds `maxPromptTokens`, `maxWallMs`; supports child carve-outs) |
| `ContextResidency` | `agent-core/src/lib/context/assemble-context.ts` | in-run half of `stubLiveToolResults` |
| `SubagentRunner` | `agent-core/src/lib/subagent/runner.ts` | `apps/api/src/lib/spawn-subagent.ts` (host keeps only persistence) |
| `AgentRegistry` | `agent-core/src/lib/subagent/profiles.ts` | static `SUBAGENT_PROFILES`; loads built-ins + `$AGENT_HOME/agents/*.md` like skills |
| `SubagentHost` | type in `agent-models` | the ad-hoc deps bag (createChildThread, append, putBlob, readBlob, writeLastRun, trace) |
| `ToolProvider` | `agent-core/src/lib/tools/registry.ts` | `ALL_TOOLS` constant |
| `resolveContextWindow` | `agent-models/src/lib/context.ts` | the inline `/api/show` override in `prepareRun` |

## 5. Phases

Order: 0 → 1 → 2 → 3 → 4 → 5 → 6. Phase 7 (the eval and observability app) comes later as its own project. Until then, Phase 0's traces are how each phase is checked.

### Phase 0: Instrument (do first, small)

Every later phase claims a token win, so the numbers have to be recorded. This phase only produces data. Building a place to view it is Phase 7.

- Roll `TokenUsage` per call into run totals; add `usage` to `run.completed` and to `RunLoopResult`. Children add to their parent.
- Log the `contextReport` layer sizes at `run_start` in the trace, so we know how the first call's tokens split between system prompt, rules, skills, plan, and history.
- Give every trace event the fields the future app will need: `threadId`, `runId`, `parentRunId`, `depth`, `iteration`, timing (`durationMs` per model call and per tool), usage per call, context window and source, eviction and compaction events, and limit reasons. Trace format becomes a versioned schema in `agent-models` (`TraceEvent` already lives there), so the app can read old traces.
- Write traces for every run (including children) through the existing JSONL sink under the thread's folder, not just the repo's `traces/`.
- Record a baseline by hand from the traces of a handful of real tasks: tokens per call, total tokens, iterations, wall clock.
- Probe whether the Ollama cloud endpoint reuses prompt prefixes: the same 100k prefix sent twice, latency compared. The design stays cache-friendly either way, but this tells us how much batching matters.

Done when: one run's trace answers, without reading code, how many tokens each call used, how long each call and tool took, what the context held at the start, and where children spent.

### Phase 1: Stop the v1 bleeding (bug fixes, with tests)

These are fixed now because they cost money or break the UI while the rebuild is in progress. Each gets a unit test.

| # | Bug | Fix |
| --- | --- | --- |
| 1 | `delegate.ts:129` passes the profile name as `subThreadId`; reloaded cards link to `/chat/review` | Add `subThreadId` to `SubagentResult`; encode it. Move `parseSubagentHeader` to `agent-models` and import it in web (delete the copy in `tool-call-panel.tsx`). |
| 2 | Parent cancel does not stop children (`agent.routes.ts:834` passes no `parentSignal`) | Pass the signal from `ToolContext`: `spawnSubagent(spec, ctx.signal)`. |
| 3 | `parentRunId` is `''` (read before `runManager.start` returns) | The runner gets `ctx.runId` from the tool context; no captured id. |
| 4 | `runManager.clear(subRunId)` never matches; child handles and buffers leak | One id: the child's `RunManager` id is the `subRunId`. |
| 5 | `tools` override widens the profile; `offer_choice` in a child hangs forever | Remove `tools` from the `delegate` schema; intersect; strip `offer_choice`, `memory`, `plan`, `todo`, `delegate` from every child. |
| 6 | `research` / `review` include `web_search` when the user turned it off | Child tools ⊆ parent registry. |
| 7 | Profile skills that do not exist are dropped silently | Validate profiles against the skill catalog at startup; log and disable the bad entry. |
| 8 | Child limits are the full workspace limits; no wall clock | Per-profile limits now (explore 20 turns / 5 min, review 15 / 5 min). |
| 9 | `delegate` in the same turn as `edit_file` reviews before the edit lands (`loop.ts:1401`) | Run the subagent stage last, after mutate. |

Tests: header round-trip; cancel parent → child status `cancelled` and handle cleared; tool intersection; no `offer_choice` in any child registry; stage order.

### Phase 2: Context diet (largest win)

**2.0 Context window policy (do first in this phase).** Today `prepareRun` sets `windowTokens` to whatever `/api/show` reports. Both `glm-5.3:cloud` and `glm-5.2:cloud` report 1,048,576, so compaction only starts at about 668k tokens. The window should be a harness budget we choose, not the model's maximum.

- **Two options only:** `ContextWindowMode = 'default' | 'model'`.
  - `default`: `min(200_000, modelMax)`. This is the setting for every new thread.
  - `model`: the model's reported context length (`/api/show`), for example 1,048,576 on the GLM cloud models.
  - If `/api/show` fails, both modes use 200k.
- **One resolver, pure:** `resolveContextWindow({ mode, modelMax }) → { windowTokens, source }` in `agent-models/src/lib/context.ts`, next to `ContextBudget`. `DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000`, and `DEFAULT_CONTEXT_BUDGET.windowTokens` uses it (it is also the loop's fallback). `ContextWindowSource` becomes `'default' | 'model' | 'fallback'`, so the meter can say why the number is what it is.
- **Stored per thread, not per request.** The window decides when compaction runs, so the run and the `maybeCompactThread` call after it must use the same value. Add a nullable `context_window_mode` column to the thread catalog (same `ensureColumn` pattern as `parent_thread_id`). It is written by `PATCH /threads/:id` and by `POST /run` when the body carries `contextWindowMode`. `/context/estimate` accepts it too, so the meter previews a change before sending.
- **UI:** a two-option toggle in the composer next to `ThinkingPicker`: "200K" and "Model max (1M)", labeled with the model's real size. If the model's max is 200k or less, the toggle is hidden. The composer remembers the last pick in localStorage for new threads. The meter's estimate cache key includes the mode. The meter popover shows the source.
- **Children:** a child resolves its own window from its own model with mode `default`, except advisor, which uses the parent's window because it forks the parent's context. Today children pass no `contextBudget` and fall back to the default.
- **Everything else scales from the window.** Compaction (2.4) is a percentage of the window. The in-run eviction trigger (2.1) and the token budget (Phase 3) stay absolute, so cost per call stays bounded even when the user picks the 1M window, but they are clamped below `window − outputReserve`.
- **Local Ollama check:** the harness never sends `num_ctx`, and Ollama's OpenAI-compatible endpoint uses the daemon's own context length. A local model may be truncating prompts silently right now. Verify with a long prompt. If it truncates, document `OLLAMA_CONTEXT_LENGTH` for the daemon, or send the window through the native API when `local` is on.

Done when: a new workspace thread on a 1M model reports a 200K window with source `default`. Switching to "Model max" changes both the run and the post-run compaction for that thread, and the choice survives reload. Tests cover the resolver: default on a 1M model, default on a 128k model (clamps to 128k), model mode, and the fallback when `/api/show` fails.

**2.1 In-run eviction.** After each tool turn, `ContextResidency` checks the live prompt estimate.
- Trigger: estimate > `inRunTriggerTokens` (default 40k).
- Keep: the last 4 tool results in full, plus tools in `neverEvict` (`plan`, `todo`, `load_skill` bodies already in system).
- Evict the rest into cards: `(evicted) read_file packages/x.ts L1-200 · 6.8k chars · sha256:… · recall(sha) to reread`. `edit_file` results become their one-line change report (path, lines ±), never dropped.
- Apply only if it frees ≥ 10k tokens (`clearAtLeast`), so the prefix changes rarely.
- Full bodies already go to blobs through `putBlob`. Add a core `recall` tool (sha + offset + limit, via `ctx.readBlob`), generalizing what `web_fetch` already does for pages.

**2.2 Re-read dedupe.** `read_file` keeps a per-run map of path+range → content hash. An unchanged re-read returns `(unchanged since iteration N, sha …)`. A successful `edit_file` on that path invalidates the entry. This plugs straight into the existing `readFileByPath` counter.

**2.3 Mid-run extractive compaction.** If the estimate still exceeds `inRunCompactRatio` of the input budget (default 0.45, about 81k on the 200K window) after eviction, collapse older iterations of the current turn into a deterministic recap: the user message, Final plan + todo state, assistant text clipped, every edit report, the last verification command and exit code, and the last 4 tool results. Same rules as `buildExtractiveSnapshot`; no LLM.

**2.4 Between-run compaction, by percentage.** Compaction stays a percentage of the window from 2.0, so it follows whichever window the thread uses.
- Start: `compactAtRatio` of the input budget (`window − outputReserve`). Keep 0.65 as the default, which on the 200K window is about 117k tokens.
- Target: add `compactToRatio` (default 0.25, about 45k tokens on 200K). Today compaction keeps the last N user turns whatever their size. The target makes it keep cutting older turns until the thread is under the ratio.
- Mid-run compaction (2.3) uses its own ratio, `inRunCompactRatio` (default 0.45).
- On the "Model max" window the same ratios apply (0.65 × 1M ≈ 670k). Per-call cost is still bounded by in-run eviction (2.1) and the token budget (Phase 3), which do not scale with the window.
- A single oversized turn is handled by 2.3, since `keepUserTurns` cannot split a turn.

**2.5 Prompt order for cache reuse.** Today the plan, mentions, brief, and last-run layers sit before history, so any plan change re-sends the whole history uncached. New order: system → skills catalog → loaded skills → rules → **history** → plan → mentions → brief → last run → current turn.

**2.6 System prompt diet.** Measure first (Phase 0 layer report), then:
- Workspace identity: a short engineering identity (~1k tokens). The writing-style "staff writer" sections stay in Home only.
- Tool guidance: workspace already uses compact guardrails; keep tool descriptions short and move long examples into skills.
- Skills catalog: names + one-line descriptions, capped.
- AGENTS.md / project rules: include, with a size cap and a note to read the file for the rest.
- Target: ≤ 20k tokens on the first call of a fresh workspace thread.

Done when: traces of the baseline tasks show median per-call prompt ≤ 45k, first call ≤ 20k, success unchanged, and recall re-reads (cards later re-opened) under 15% of evictions. If re-reads are higher, raise `keep`.

### Phase 3: Token budget machine

- `RunBudget { maxPromptTokens, maxCompletionTokens?, maxWallMs, maxIterations, maxToolCalls }`, charged from real `usage` after each call. If a provider omits usage, fall back to `estimatePromptTokens`.
- At 80%: one host nudge ("Budget nearly spent: finish the current step, verify, and report what is left").
- At 100%: the existing `completeAfterLimit` path with `limitReason: 'limit.tokens'`.
- Children get a carve-out from the parent pool (default 25% of what is left, capped per profile). Their spend is charged back to the parent.
- Starting defaults (tune from trace data): workspace 2.5M prompt tokens per run, home 400k, wall clock 30 min. Show live spend in the composer meter next to the Ollama balance.

### Phase 4: Sub-agents, rebuilt

**4.1 Runner in core.** `SubagentRunner` lives in `agent-core`; the API supplies a `SubagentHost` (persistence only). `RunManager.start` takes `parent: { runId, signal, budget, depth }`. The child's abort signal is `AbortSignal.any([parentSignal, own])`. The child is cleared when it settles. `apps/api/src/lib/spawn-subagent.ts` shrinks to the host adapter.

**4.2 Agent registry as data.** A profile is `{ name, description, model role, tools, limits, context: 'none' | 'diff' | 'fork', rules: boolean, prompt, output schema }`. Built-ins live in core; user agents load from `$AGENT_HOME/agents/<name>.md` (frontmatter + prompt body), using the same loader pattern as skills. Startup validation rejects unknown tools, models, or skills. This is the seam plugins use later.

**4.3 Built-in profiles.**

| Profile | Model role | Context | Tools | Limits | Report |
| --- | --- | --- | --- | --- | --- |
| `explore` | fast | none (brief only, no AGENTS.md) | glob, grep, read_file, recall; web tools only if the parent has them | 20 turns, 5 min | findings with `path:line` evidence, files of interest, open questions |
| `review` | strong | diff: `git diff` of the workspace + the user's original request + AGENTS.md | read tools + read-only `diff` | 15 turns, 5 min | issues: location, problem, fix, severity; out-of-scope flagged |
| `advisor` | strongest | fork: the parent's messages (same prefix, so cache-friendly) + one question | none, or read tools | 3 turns, 3 min | recommendation, risks, what to try next |

`implement` and `plan` are removed. Writes stay with the parent, and planning needs the conversation that only the parent has.

**4.4 Child prompt preset.** At most ~1.5k tokens: role, environment (workspace root, OS, date), tool list, the brief, the output schema, and "stop when the report is complete". No identity file, no BLUF rules, no plan protocol, no skill catalog.

**4.5 Report contract.** The child finishes by calling a `report` tool whose JSON schema is per profile. The harness validates it. If the child ends without one, its final text becomes `summary` and `status` is `incomplete`. The parent receives a rendered digest (≤ 1.5k tokens) wrapped in `UNTRUSTED_SUBAGENT_BEGIN/END`. The full report goes to a blob, whose sha is in the header, so the parent can `recall` it.

**4.6 Brief contract.** `delegate({ profile, objective, scope, outputFocus?, thoroughness?, resume? })`. `objective` and `scope` are required, which forces the parent to write the brief Anthropic found to matter: objective, scope, expected output, boundaries.

**4.7 Resume.** `delegate({ resume: subThreadId, objective })` continues a child that stopped at a limit, with its history intact, instead of re-exploring.

**4.8 Concurrency and dedupe.** At most 4 children at once per run (a semaphore). Briefs identical in profile + objective + scope within a turn collapse into one call.

**4.9 Parent policy (short, in the workspace prompt).**
- Delegate to `explore` when the answer needs more than ~5 files, more than 3 searches, or any web research. Answer it yourself otherwise.
- After edits pass verification, call `review` once. Fix findings that fall within the user's request; list the rest instead of acting on them. At most one re-review.
- Call `advisor` when stuck. The loop also suggests it when the same failing outcome repeats twice or the repeat detector fires.
- Never delegate verification or edits.

**4.10 Observability and UI.** Child trace events go to the parent's sink, tagged with `parentRunId` and `depth`. A throttled `subrun.progress` event (tool count, last tool) feeds the card. Usage rolls up into the parent's `run.completed`. The card rebuilds from the ledger header alone.

**4.11 Depth.** Children have no `delegate`. Depth stays 1 unless a measured use case justifies more.

### Phase 5: Model roles

- `ModelRoles { main, fast, strong }` in `agent-models`, set by config, with the current model as the default for all three.
- Call options (context length, temperature, thinking) resolve per model, not inherited from the parent's options. This fixes children reusing the parent's `callOptions`.
- `explore` → fast, `review` → strong, `advisor` → strongest available, parent → the user's pick.

### Phase 6: Extension seams (MCP and plugins later)

None of MCP is built here. The goal is that adding it later is a provider, not a rewrite.

- `ToolProvider { id, tools(): Tool[] }`. Built-ins, host tools (memory, plan), and later MCP servers are providers. `createToolRegistry(providers, policy, posture, parentCapabilities)`.
- Tool metadata gains `stage` (parallel-safe read / network / exec / mutate, replacing the name switch in `toolStage`) and `outputCap`. External tools default to the strictest stage and a small cap.
- **Deferred tools:** once the tool count passes a threshold (~25), only names and one-line descriptions go into the prompt; a `tool_search` tool loads full schemas on demand. This keeps MCP from blowing up the system prompt.
- A plugin manifest bundles skills, agents, and providers. Everything still passes the posture gate, the path jail, and capability intersection for children.
- Untrusted output markers apply to any external tool result, as they do for web pages today.

### Phase 7 (later, separate project): Eval and observability app

Not part of this round. It gets its own app or package (its own Nx project), not a module inside `apps/agent`, and its own design doc when it starts. Recorded here so the earlier phases produce what it needs.

- **Trace viewer:** every thread, every run, every model call and tool call, with timing, token usage, context layers, evictions, compaction, child runs nested under their parent, and limit reasons.
- **Performance views:** tokens per call and per task, prompt-to-completion ratio, wall clock, re-read rate after eviction, child cost vs. parent, budget hits.
- **Eval runner:** ~20 real workspace tasks against fixture repos, with end-state checks (tests pass, file assertions) and scope checks (files touched ⊆ allowed). The existing `apps/agent/src/eval` Home Q&A scenarios move into it.
- **Regression gate:** runs before changes to the loop, assembler, prompts, profiles, or limits merge. It fails on a success drop, a token increase over 10%, or more scope violations. The set grows from real failures.
- Optional: an LLM judge with a rubric (correct, in scope, verified, efficient), kept off the request path.
- Input contract: the versioned trace schema from Phase 0. The app only reads traces and the ledger; it never changes the runtime.

## 6. Standard practices

For the agent (encode these in prompts and gates, not just docs):
- Read before writing; cite `path:line`; never claim verification without a command result.
- Batch edits, then verify once; debug with verify-after-each only while chasing a specific error.
- Delegate wide reading, never writing or verification.
- Stay inside the request: out-of-scope findings get listed, not fixed.
- Stop on budget warnings: finish, verify, report what is left.

For developers changing the harness:
- Every harness change states its effect on prompt tokens per call, measured from traces (the eval gate takes over once Phase 7 exists).
- New capability = tool + gate + output cap + stage + guidance, in one change.
- New prompt text must replace text, not just add it. Check the layer report.
- No new LLM calls on the request path.
- Every tool result, child report, and external payload is data, never instructions.

## 7. Trade-offs and risks

| Risk | Mitigation |
| --- | --- |
| Eviction drops something the model needed, so it re-reads | Cards carry sha + location; `recall` is cheap; tune `keep` from the re-read rate |
| Each eviction batch invalidates any prefix cache | `clearAtLeast` keeps batches rare and large |
| Review loops or scope creep | One review plus at most one re-review; findings filtered by the user's request |
| Advisor fork is expensive | Only on stuck signals; 3-turn cap; budget carve-out |
| Fast model weaker at exploration | `thoroughness` param; review stays on the strong model; eval decides the role mapping |
| On the "Model max" window, percentage compaction starts very late (~670k on 1M) | In-run eviction and the token budget stay absolute, so per-call and per-run cost stay bounded; 200K stays the default |

## 8. Out of scope on purpose

- Parallel writer sub-agents (until worktree isolation exists and evals show a gain).
- Agent swarms or agent-to-agent messaging.
- LLM-written summaries on the request path.
- Nesting deeper than one level.
- Building MCP or plugin support itself (Phase 6 only prepares the seam).

## 9. Implementation status (2026-10-29, branch `subagents`, uncommitted)

Phases 0–6 are implemented; Phase 7 is deferred to a later branch.

| Phase | Where it landed | Deviation from the text above |
| --- | --- | --- |
| 0 Instrument | `RunUsage` in `agent-models/run.ts`; usage on `RunLoopResult`, `run.completed`, `turn.completed`; `TraceEvent` v2 (`agent-models/trace.ts`) with run_start layers/window, per-call duration, `resultChars`, eviction/compaction/budget events, `run_finish` usage; traces under `sessions/<thread>/traces/` | Repo `traces/` is no longer written. Cache-reuse probe not run. |
| 1 v1 bugs | All nine fixed by the Phase 4 rebuild (header carries the real `subThreadId`; cancel chains through `parentSignal`; one run id; no tool override; tools ⊆ parent; per-profile limits; sub-agent stage runs last) | Built-in profiles no longer reference skills, so the missing-skills bug is gone rather than validated. |
| 2.0 Window | `resolveContextWindow` / `contextBudgetForWindow` (`agent-models/context.ts`), `resolveContextBudget` (`apps/api/src/lib/model-runtime.ts`), `threads.context_window_mode`, composer `ContextWindowPicker` | Two options only (200K default, model max), per the later decision. |
| 2.1–2.3 Residency | `agent-core/src/lib/context/residency.ts` (`evictToolResults`, `compactCurrentRun`, `ReadDedupe`), wired in `loop.ts` `manageResidency` / `shapeToolResult`; `recall` tool | Own module instead of inside `assemble-context.ts` (prompt-only, run-scoped logic). |
| 2.4 Compaction | `chooseCompactThroughSeqForTarget`; `compactAtRatio` 0.65 start, `compactToRatio` 0.25 target | Percentage-based, per the later decision. |
| 2.5 Order | `assembleContext`: system → catalog → memory → rules → brief → history → skill bodies → plan → mentions → last run → turn | — |
| 2.6 Diet | Workspace identity and rule caps were already lean; skill catalog descriptions capped at 200 chars | — |
| 3 Budget | `maxPromptTokens` / `maxWallMs` in `ModeLimits` / `AgentLimits`; 80% nudge; `limit.tokens` / `limit.wall`; child carve-out 25% of parent remaining; composer meter shows run spend | — |
| 4 Sub-agents | `agent-core/src/lib/subagent/{types,profiles,delegate,prompt,runner}.ts`; API host `apps/api/src/lib/subagent-host.ts`; user agents from `$AGENT_HOME/agents`; read-only `diff` tool | `SubagentHost` lives in core (it needs `ModelCallFn`), not agent-models. Advisor suggestion fires on the second identical exec outcome. |
| 5 Model roles | `ModelRole` / `resolveModelRoles` (`agent-models/mode.ts`); env `AGENT_MODEL_FAST`, `AGENT_MODEL_STRONG`; per-model call options for children (thinking off) | — |
| 6 Seams | `ToolProvider` + `registerToolProvider` / `listTools` (`ALL_TOOLS` removed); `Tool.stage`, `Tool.outputCap` | Deferred tool loading (`tool_search`) not built: no consumer until MCP lands. |

## 10. Sources

- Claude Code sub-agents: https://code.claude.com/docs/en/sub-agents
- Anthropic, multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- Anthropic, effective context engineering: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Claude API context editing (`clear_tool_uses`, `clear_at_least`): https://platform.claude.com/docs/en/build-with-claude/context-editing
- Gemini CLI sub-agents: https://geminicli.com/docs/core/subagents/
- Goose sub-agents: https://block.github.io/goose/docs/guides/subagents
- Cognition, Don't Build Multi-Agents: https://cognition.ai/blog/dont-build-multi-agents
- Cognition, Multi-Agents: What's Actually Working: https://cognition.com/blog/multi-agents-working
