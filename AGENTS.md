<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Run Nx as `npx nx …` or `nx …` (global CLI is fine). This workspace uses npm (`package-lock.json`). Do not use pnpm.
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->

# Personal Assistant

Nx monorepo for a personal agent harness. One runtime (`agent-core`), two bindings: **Home** (chat, optional web) and **Workspace** (folder-bound coding tools). Setup, env, and the HTTP surface are in [README.md](./README.md).

`apps/web` is the chat product. `apps/eval` is the measurement viewer. They are not the same UI.

## Modules

| Project | Role | Use |
| ------- | ---- | --- |
| `packages/agent-models` | Shared shapes. Imports nothing. | Events, ledger, trace, threads, plans, modes (`HOME_MODE` / `WORKSPACE_MODE`), review artifact. One file per family under `src/lib/` (`event.ts`, `ledger.ts`, `trace.ts`, `run.ts`, `thread.ts`, `mode.ts`, `review.ts`, …). |
| `packages/agent-core` | Host-agnostic runtime. No HTTP, DOM, or database. | Loop, tools, context, model calls, sub-agents, System 1. Public surface is `src/index.ts`; the rest stays internal. |
| `apps/api` | Express host on disk. | `/api/agent/*`: threads, runs, memory, skills, models. Optional `/api/voice`. Wires env, stores, System 1, traces. |
| `apps/web` | Next.js chat. Imports `agent-models` only, never `agent-core`. | Composer, thread view, sidebar, usage meters. Rebuilds from the ledger; SSE is the live path. |
| `apps/cli` | Terminal host. | Runs core directly (no HTTP). Leftover `src/eval/` is not the eval product. |
| `packages/agent-eval` | Read-only measurement. Imports `agent-models` only, never `agent-core`. | Readers, metrics, trial runner, gate. Trials talk to the HTTP API; they do not run a second loop. |
| `apps/eval` | Next.js viewer over `agent-eval`. Does not import `agent-core`. | Suite results, run traces, usage, thread/run **Review**. Not the chat UI. |
| `evals/` | Task corpus (not an Nx project). | `evals/tasks`, `evals/baselines`, plan of record in `evals/ROADMAP.md`. |

Lint (`@nx/enforce-module-boundaries` in `eslint.config.mjs`) matches this: `type:data` → `type:logic` → `type:app`. `scope:web` cannot import logic packages. `apps/eval` is `scope:eval` and still does not import `agent-core`.

## Chat flow

```
apps/web composer (features/composer)
  → POST /api/agent/run          apps/api/src/runs/runs.routes.ts → start-run.ts
  → assemble run context         runs/run-context.ts (ledger, memory, skills, workspace, compaction)
  → RunManager.start             packages/agent-core/src/lib/run/run-manager.ts
  → runLoop                      packages/agent-core/src/lib/loop/loop.ts
  → GET /api/agent/run/:id/events  SSE AgentEvent
  → chat-store / use-agent-run   apps/web/src/features/conversation/
```

One active run per thread, in process memory. After `RUN_HANDLE_TTL_MS` (5 minutes) a late SSE subscribe is 404; the client rebuilds from `GET /api/agent/threads/:id/ledger`. Retry/edit **rewinds** (truncates) the ledger. Title generation (`runs/thread-title.ts`) is maintenance, not on the request path.

**Home vs Workspace** is `packages/agent-models/src/lib/mode.ts`: allowed tools, global tools, iteration/token/wall limits. Home is chat; Workspace adds folder-jailed coding tools (`edit_file`, `run_terminal`, `delegate`, `diff`).

## Disk layout (`AGENT_HOME`)

Host-owned. Typical path: `.local/personal-assistant/`.

| Path | What |
| ---- | ---- |
| `catalog.db` | Thread index (SQLite). |
| `sessions/<threadId>/ledger.jsonl` | Active tape. Append-only until rewind. |
| `sessions/<threadId>/traces/<runId>.jsonl` | Per-run facts core recorded (schema `TRACE_SCHEMA_VERSION`). |
| `sessions/<threadId>/` blobs | Large bodies, recorded model-call payloads. |
| `reviews/<threadId>.json` | Stored thread Review (eval app). |

Eval reads these files. It does not re-derive what core already put in the trace.

## Runtime (major files)

**Loop** — `packages/agent-core/src/lib/loop/`

- `loop.ts` — iteration: model turn → tools → budget/limits → finish. Replay snapshots in `__replay__/` pin event/trace order.
- `limits.ts`, `run-budget.ts` — iteration, tool-call, token, and wall caps.
- `repetition-guard.ts`, `progress-steering.ts` — stall / research-gate (absolute marks 750k / 1.25M).
- `model-call.ts`, `call-record.ts` — streaming call; optional content-addressed recording of exactly what the model saw.
- `to-ledger-record.ts` — loop output → ledger row.

**Context** — `packages/agent-core/src/lib/context/`

- `assemble-context.ts` — builds the prompt. Old tool results stub first, then attachments; large bodies spill to blobs; tape compact last.
- `residency.ts` — in-run eviction (`(evicted)` cards) and extractive recap. Compaction is not an LLM call.
- Host-side between-run compact: `apps/api/src/runs/compaction.ts`. Window size: `apps/api/src/models/model-runtime.ts` + `agent-models/src/lib/context.ts`.

**Tools** — `packages/agent-core/src/lib/tools/`

- `registry.ts` — per-run allow list (composer toggles ∪ mode `globalTools`).
- `web/` — `web_search` (opt-in), `web_fetch` (always).
- `workspace/` — path jail, `read_file` / `edit_file` / `run_terminal`.
- `memory.ts`, `plan.ts`, `offer-choice.ts`, `recall.ts`, `skills.ts`.
- Memory / posture / path jail are deterministic gates (`memory/gate.ts`), not prompt text.

**Model and System 1**

- `model/client.ts`, `model/stream.ts` — Ollama (cloud or local).
- `system1/port.ts` — classifier: state + questions → scores (`ask` / `report`). Not a writer. Host wires it in `apps/api/src/runs/system1-runtime.ts`.

**Sub-agents** — `packages/agent-core/src/lib/subagent/` (`delegate.ts`, `profiles.ts`, `runner.ts`). Host: `apps/api/src/runs/subagent-host.ts`. Profiles: explore, review, advisor, user agents under `$AGENT_HOME/agents/`. Children cannot nest; cancelled with the parent.

**Events** — `packages/agent-models/src/lib/event.ts` is the live API shape. Core emits (`events/emitter.ts`, `events/trace.ts`); API streams; web reduces; eval reads the on-disk trace/ledger.

## Hosts (major files)

**API** — `apps/api/src/`

- `main.ts` — mounts routers under `/api/agent`.
- `threads/thread-store.ts` — catalog + ledger + plans on disk.
- `threads/threads.routes.ts` — thread CRUD, ledger GET, workspace pick.
- `runs/start-run.ts`, `runs.routes.ts` — start, cancel, choice, SSE, events.
- `platform/agent-home.ts`, `platform/instances.ts`, `platform/trace-sink.ts`.
- `memory/`, `skills/`, `models/`, `voice/` — each topic’s route next to its store.

**Web** — `apps/web/src/`

- `app/chat/[threadId]/page.tsx` — thread page.
- `features/conversation/` — `use-agent-run`, `chat-store`, message list, cards (`thread-session` is the SSE/ledger client).
- `features/composer/` — input, model/thinking/web/skills/voice.
- `features/threads/` — sidebar, spaces, workspace picker.
- `features/usage/` — context and account meters.
- `api/` — HTTP clients, one per topic.

**CLI** — `apps/cli/src/` — `local-run.ts` drives core in-process.

## Eval flow

Trials: `packages/agent-eval/src/runner/runner.ts` grades a task by calling the **same HTTP API** (`runner/api-client.ts`), then reading the thread’s ledger/traces. Budget stop cancels a trial at 2× its token budget. Gate/baseline: `gate/`. CLI entry: `cli/main.ts`.

Viewer (`apps/eval`): server pages over those readers — `/results`, `/results/[id]`, `/runs/[id]`, `/threads/[id]`, `/usage`. Home path: `apps/eval/src/lib/home.ts`.

**Review** (thread/run performance, not the `delegate(review)` sub-agent):

- Digest: `packages/agent-eval/src/analyze/review.ts` (`analyzeThread`, `buildReviewInput`) — metrics + ≤5 `run_finish` excerpts, no whole-trace dump.
- Types: `packages/agent-models/src/lib/review.ts` (`ReviewArtifact`, `reviewFingerprint`).
- UI: `apps/eval/src/review/` (verdict, CTA, store, narrative). Destination is `/threads/[id]/review`. Thread and run pages link/run a review; they are not the review document. Unchanged fingerprint serves `reviews/<threadId>.json`; narrative is one bounded JSON call over the digest.
