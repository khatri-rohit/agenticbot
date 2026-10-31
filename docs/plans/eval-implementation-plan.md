# Eval & Observability — Implementation Plan

> Companion to `eval-observability-plan.md` (stages E0–E5, data contract, run instructions).
> That doc defines **what** gets built and **how to run it through the harness.
> This doc defines the **mental model**, the **improvement loop**, **grading and
> statistics standards**, and the feedback cycle that turns eval output into harness changes.
> A workspace thread should be able to build any stage from these two files alone.
## 1. Mental model

**The unit under test is harness + model together.** We are not benchmarking a model;
we are measuring whether *our* loop, tools, gates, and compaction let the model succeed
within budget. (Anthropic: "When we evaluate 'an agent,' we're evaluating the harness and
the model working together.")

Four ideas, mapped to this repo's existing mental models:

| Eval concept | In this repo | Notes |
|---|---|---|
| **Task** | One JSON task in `evals/tasks/*.json` | Input prompt + pinned commit + checks |
| **Trial** | One run of one task → one `runId` | Model output is stochastic; contracts are not |
| **Transcript / trace** | `traces/<runId>.jsonl` (seq-ordered) + `ledger.jsonl` | The ledger is the truth; traces are the detail |
| **Outcome** | End state of the workspace at the pinned commit | Graded from files/tests, **not** from the transcript |
| **Harness (eval)** | `packages/agent-eval` runner + graders | Read-only over artifacts; no runtime instrumentation |
| **Suite** | `evals/tasks/` + baseline in `evals/baselines/` | Capability tasks + regression tasks |

Two rules follow directly:

1. **Grade the outcome, not the conversation.** A run that says "done" but wrote no
   files fails; a run that hit `limit.tokens` but produced correct files may pass
   capability checks and fail efficiency checks. The transcript is for *diagnosis*,
   the end state is for *scoring*. (Anthropic: graders should read the end state,
   not the transcript; the flight-booking example — the agent's claim is not the outcome.)
2. **The eval harness is a reader, not a writer.** Everything E0/E1 need already
   exists: `catalog.db`, `ledger.jsonl`, `traces/*.jsonl`, `last-run.json`,
   `usage.jsonl`. No new writes to `$AGENT_HOME`, no new events, no request-path
   changes. This is the same discipline as "no LLM on the request path."

## 2. Standard architecture

```
packages/agent-eval/          # pure TS lib, no HTTP/DOM/DB-writes
  src/read/                   # E0: catalog, ledger, trace, usage readers
  src/metrics/                 # E1: per-run and per-thread metrics
  src/runner/                  # E2: task suite runner (drives the API)
  src/graders/                 # E2/E5: checks, file checks, judge
  src/gate/                    # E3: baseline compare + pass/fail
apps/eval/                     # E4: Next.js viewer (server components)
evals/
  home/                        # isolated AGENT_HOME for eval runs
  tasks/*.json                 # task definitions (pinned commits)
  baselines/*.json             # recorded baseline results
  results/<ts>-<label>/        # run outputs: summary.json, per-task results
```

Boundaries (same ownership map as the rest of the repo):

- `agent-eval` imports `@agent/agent-models` types only. It never imports Express,
  React, or the runtime loop. It talks to the agent through the **HTTP API** for
  trials (E2) and through **files** for reading (E0/E1/E3).
- The runner (E2) requires a **running API** with `AGENT_HOME=evals/home` — it does
  not start or manage the API process. Document the env setup as a prerequisite.
- The viewer (E4) imports `@agent/agent-eval` directly in server components and
  reads `evals/results/` from disk. No HTTP hop, no second reader.
- Catalog access uses `node:sqlite` `DatabaseSync` opened **read-only**
  (`{ readOnly: true }`) — same Node ≥ 22.5 floor as `apps/api`. A plain open
  creates WAL files in `$AGENT_HOME`, which violates read-only.

## 3. The improvement loop

This is the whole point of the system. Every harness change goes through it:

```
        ┌──────────────────────────────────────────────────┐
        │                                                  ▼
  baseline ──▶ make change ──▶ run suite ──▶ compare vs baseline ──▶ gate
  (E3)          (loop/tools/       (E2, n trials      (medians, pass@k,
                 gates/prompts)     per task)          token deltas)
                                                        │
              ┌─────────────────────────────────────────┤
              │ pass                                    │ fail
              ▼                                         ▼
        merge + record new baseline              open failing traces in
        (baselines/*.json)                      viewer (E4), diagnose,
              │                                  fix, re-run
              │                                         │
              └──────────▶ mine failures ──▶ new/adjusted tasks ──▶ back to baseline
```

Loop rules:

- **One change per eval run.** If two harness changes are in flight, the comparison
  is unattributable. The runner records the git SHA of the harness in every result.
- **Never compare single trials.** Compare distributions: median tokens, pass@k
  across n trials, spread. A single trial tells you nothing (Anthropic: run multiple
  trials because outputs vary; OpenAI: generative AI is variable, traditional
  testing is insufficient).
- **Regression and capability are different suites.** Regression tasks should pass
  ~100% and any drop is a red alert. Capability tasks should start *hard* (low pass
  rate) so there is a hill to climb. When a capability task saturates, graduate it
  into the regression suite (Anthropic's capability→regression graduation model).
- **Failures are the product.** Every failing trial produces a trace link in the
  summary. The improvement step is: open the trace, find the *first* wrong decision
  (wrong tool, wasted reads, missed gate), fix that layer, re-run. Do not tune
  prompts to individual failures — fix the layer that owns the behavior
  (limits, registry, compaction), per the repo's boundary rule.

## 4. Grading ladder (cheapest that actually measures)

Order graders cheapest-first and stop at the first one that genuinely measures the
success criterion (Anthropic build-eval skill; OpenAI: automate when possible):

1. **End-state checks (free, deterministic).** File exists / contains / compiles /
   test command passes at the pinned commit. This is the primary grader for a
   coding agent. Checks run against the workspace *after* the trial, not against
   the transcript.
2. **Budget checks (free, deterministic).** Tokens ≤ task budget, iterations ≤ cap,
   no `limit.*` finish. These come from `usage.jsonl` + run metadata, not from
   re-reading the model.
3. **Scope checks (free, deterministic).** Diff touches only allowed paths
   (`allowedPaths` in the task). Catches over-reach regardless of correctness.
4. **Pairwise judge (E5, optional).** Judge reads task + two final outputs
   (candidate vs baseline) and picks better, against a short rubric. Use when
   quality is fuzzy and a baseline exists. Judges are better at "which is better"
   than at absolute scores (OpenAI: LLMs are better at discriminating).
5. **Pointwise rubric judge (E5, optional).** Only when there is no baseline or an
   absolute per-case number is needed. Keep rubrics short and concrete.

Judge hygiene (both official guides agree):

- **Judge model ≠ agent model.** Use a different (stronger) model for grading.
- **Judges are graders, not oracles.** Calibrate: human-review a sample of judge
  decisions before trusting a judge-based gate; re-calibrate periodically
  (OpenAI: calibrate automated metrics against human evals).
- **Never derive gold answers from the model under test.** Reference-match scoring
  then rewards imitation of the incumbent (Anthropic build-eval).
- **Volume beats hand-grading.** More tasks with cheap automated grading > few
  tasks with expensive manual grading (Claude docs: prioritize volume).

## 5. Statistics standard

- **Trials:** default 3 per task per run (matches the existing plan's repeat-3
  spread). Report `pass@3` (all pass), `pass@any` (at least one), and per-trial
  token medians. Raise to 5 for tasks near the gate threshold.
- **Gate (E3):** fail if success rate drops at all on regression tasks, or median
  tokens rise > 10% on any task. Both compared on medians, never single trials.
- **Spread is a signal, not noise to hide.** If repeat-3 token spread on a task
  exceeds ~2×, that task is unstable — flag it in the summary; unstable tasks
  can't gate merges.
- **Suite size:** 15–100 tasks for a first suite (Anthropic build-eval: below 15 a
  single flaky case swings the score; above 100 nobody reviews them). Start ~20,
  grow from mined failures.
- **Task sources, in order of value:** (1) real failures from our own traces —
  the `d8d1e745` run is the seed case; (2) bug reports / "this went wrong"
  moments; (3) hand-written edge cases. Synthesize only from real anchors.

## 6. Feedback: from eval output to harness change

The analysis workflow, concretely:

1. **Read the summary first.** `summary.json` per run: per-task pass@3, token
   medians, spread flags, finish-reason histogram (`end`, `limit.tokens`,
   `limit.iterations`), scope violations.
2. **Triage by pattern, not by case.** Look for classes:
   - many `limit.tokens` finishes → budget machine problem (`loop/limits.ts`),
     not a prompt problem;
   - high read counts before first edit (the `d8d1e745` ~15-read walk) → context
     assembly / eviction policy, or tool result compaction;
   - scope violations → gate or registry boundary, not instructions;
   - passes but 2× tokens vs baseline → compaction or dedup regression.
3. **Open the trace for one representative failure per class** (E4 viewer).
   Find the first wrong decision. Everything after it is compounding noise.
4. **Fix the owning layer** (per the architecture map), re-run only the affected
   tasks first (cheap), then the full suite before merging.
5. **Record the fix as a task.** If a class of failure was invisible to the suite
   before, add a task that would have caught it. This is how the suite grows —
   from failures, not from imagination.
6. **Update the baseline only through the gate.** A new baseline is written by the
   gate tool after a passing comparison, never by hand.

## 7. Best practices checklist (from the official guides)

Adopted as rules for this system:

- [x] Eval-driven development: run the suite on every harness change, early and
      often (OpenAI). E0/E1 cost nothing — run them constantly.
- [x] Task-specific over generic: tasks mirror real workspace-thread work, not
      abstract benchmarks (Claude docs, OpenAI).
- [x] Log everything: we already do — ledger, traces, usage. Evals mine these
      logs for cases (OpenAI: mine logs for eval cases).
- [x] Grade outcomes through the real entry point: trials go through
      `POST /api/agent/run` like production, never by calling `runLoop` directly
      (Anthropic build-eval: measure real outcomes through the real entry point).
- [x] Isolated, reproducible environment: pinned commits, `evals/home` AGENT_HOME,
      no live external state (Anthropic build-eval: fixtures/test instances).
- [x] No vibe-based evals: "it seems fine" is not a gate (OpenAI anti-pattern list).
- [x] Human calibration of judges before they gate anything (OpenAI).
- [x] Capability vs regression split with graduation (Anthropic).

## 8. Stage plan (extends E0–E5 in the companion doc)

Amendments to the companion doc's stages, agreed in review:

- **E0 (reader):** declare the `node:sqlite` / Node ≥ 22.5 dependency; open the
  catalog read-only. Add fixture-based unit tests for the trace parser (v1 shapes,
  missing `seq`, corrupt lines) despite the deferred-tests constraint — every later
  stage depends on this parser.
- **E2 (runner):** drop the "or start the API" branch. Prerequisite: a running API
  with `AGENT_HOME=evals/home`. The runner records the harness git SHA per result.
- **E4 (viewer):** seam is `apps/eval` importing `@agent/agent-eval` in server
  components, reading `evals/results/` from disk. Note in the doc that a
  thread-drilldown observability board (workspace → threads → trace drawer) is
  **deferred to a later phase doc** and must reuse this same reader — do not
  over-build the E4 timeline anticipating it.
- **E5 (judge):** only after E3 gates are green and stable. Judge model must differ
  from the agent model; calibrate on a human-reviewed sample before it can gate.

Stage order and cost model unchanged: E0/E1 free → run them first as the safe test
of the harness itself; E2/E3 spend capacity → one stage per workspace-thread run,
Continue on limits, per the companion doc's run instructions.

## 9. Sources

- Anthropic, *Demystifying evals for AI agents* (Jan 2026) —
  https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
  (definitions: task/trial/grader/transcript/outcome/harness/suite; outcome-over-
  transcript grading; capability vs regression; graduation).
- Anthropic skills repo, *Building an Eval for a Claude-Powered Application* —
  https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/evals/build-eval.md
  (grading ladder cheapest-first; 15–100 tasks; real entry point; isolated env;
  never derive gold from the model under test).
- Anthropic docs, *Define success criteria and build evaluations* —
  https://platform.claude.com/docs/en/test-and-evaluate/develop-tests
  (task-specific, automate, volume over quality, judge with a different model).
- OpenAI, *Evaluation best practices* —
  https://developers.openai.com/api/docs/guides/evaluation-best-practices
  (eval-driven development, log mining, pairwise discrimination, calibrate against
  human evals, anti-patterns: vibe-based evals, generic metrics).