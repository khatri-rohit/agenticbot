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

# Personal Assistant — guide for contributors and coding agents

This is the one guide for working in this repo. `CLAUDE.md` and `.cursor/rules/` point here. [README.md](./README.md) covers setup, the API surface and design notes.

The goal of every change: **the next change gets cheaper to understand and make.** Complexity is whatever makes the system hard to understand or modify. It grows one reasonable-looking change at a time, so each change has to leave the structure at least as clear as it found it.

## Ownership

| Layer        | Project                                  | Owns                                                                                     |
| ------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Contract     | `packages/agent-models` (`type:data`)    | Shared shapes: events, ledger, trace, threads, plans, modes. Imports nothing.            |
| Runtime      | `packages/agent-core` (`type:logic`)     | Loop, tools, context, model calls, sub-agents, System 1. No HTTP, DOM or database.       |
| HTTP host    | `apps/api` (`type:app`)                  | Express routes, stores on disk, env wiring.                                              |
| UI           | `apps/web` (`type:app`, `scope:web`)     | Next.js chat UI. Imports only `agent-models`, never `agent-core`.                        |
| CLI / eval   | `apps/cli` (`type:app`)                  | Runs the core directly from a terminal; eval scenarios.                                  |

Lint enforces these arrows (`@nx/enforce-module-boundaries` in `eslint.config.mjs`). Loop correctness, tool execution, limits and event order belong in core; status codes, CORS and UX belong in the hosts.

## Where code goes

Organise by **what the code is about**, not by what kind of file it is. Look for the folder that owns the topic before creating a new one.

**`apps/api/src/`**: one folder per topic, with its route file next to the code it uses:
`threads/` (thread CRUD, ledger, workspace pick, `thread-store`), `runs/` (start a run, run context, compaction, cancel/choice/events, sub-agent host, System 1 wiring, titles), `memory/`, `skills/`, `models/` (model list/config, account balance and capacity), `voice/`, and `platform/` (process-wide instances, agent home, logger, trace sink). Routes only parse requests and shape responses; the work lives beside them (for example `runs/start-run.ts`).

**`apps/web/src/`**:
- `app/`: Next.js routes only.
- `features/conversation/`: the thread view (message list, cards, chat store, `use-agent-run`).
- `features/composer/`: the input box and everything it controls (pickers, voice, skills, drafts).
- `features/threads/`: sidebar, thread lists, spaces, workspace picker.
- `features/usage/`: context and account usage meters.
- `api/`: HTTP clients for the API, one per topic.
- `components/ui/`: shadcn primitives (generated; keep as is). `components/shell/`: app frame and providers.
- `hooks/`, `lib/`: generic helpers with no feature knowledge only.

**`packages/agent-core/src/lib/`**: `loop/` (the run loop and its state: budget, steering, repetition guard, web sources), `context/`, `tools/` (`web/`, `workspace/`, one file per other tool family), `model/`, `subagent/`, `system1/`, `run/`, `events/`, `memory/`, `prompts/`. Add to `src/index.ts` only what a host needs. Everything else stays internal.

**`packages/agent-models/src/lib/`**: one file per shape family. Types and pure helpers on those types only.

## Naming

- Files are kebab-case. React hooks are `use-*.ts(x)`. Express routers are `<topic>.routes.ts` and export `<topic>Router`.
- Name a file after what it is about inside its folder (`tools/web/providers.ts`, not `tools/web-search-providers.ts`).
- Tests sit next to the code: `<name>.test.ts`.
- Web imports use `@/…`. Core and API use relative imports inside a project and package names across projects.

## Module design

- **Deep modules.** A module should hide more than it shows: a small interface over real work or state. `system1/port.ts` (`ask`, `report` over client, breaker, budget and recorder) and `loop/run-budget.ts` are the references.
- **Split on interfaces, not line counts.** Split when a piece has its own state and a small interface; leave a large file whole when its parts must be read in order (the iteration loop in `loop.ts`) or must coordinate (`threads/thread-store.ts`).
- **No pass-through layers.** No component or function that only forwards a dozen props or arguments, no index files that only re-export, no wrapper around a single call.
- **One copy.** Before writing a helper, search for it. Share it once it has three identical callers; near-copies that behave differently keep their own names.
- **Comments** say why or state a contract, on the non-obvious parts. They don't narrate the next line.
- **No defensive theater.** Validate at trust boundaries (HTTP bodies, model output, files, env), not inside trusted code.

## How the harness thinks

- **Events are the API between core and UI.** Changing an event shape means updating core, the API, the web store and the CLI together. The UI must rebuild from `GET /ledger`; SSE is only the fast path.
- **Ledger over stream.** Any UI state that cannot be rebuilt from the ledger is a bug. Retry/edit rewinds (truncates) the ledger.
- **Budget machine.** Looping is a limits problem (`loop/limits.ts`, `loop/repetition-guard.ts`, `loop/progress-steering.ts`), not a prompt problem.
- **Context is a cache.** Stubbing and eviction are cache decisions (`context/`). New capabilities are judged by what they keep resident.
- **Gate over prompt.** The model proposes, a gate disposes (memory, posture, path jail, web trust). Ship the gate with the capability.
- **No LLM on the request path** (admission, assembly, compaction). Title generation is maintenance.
- `RunManager` keeps one active run per thread in process memory. Late SSE after `RUN_HANDLE_TTL_MS` is a 404; the ledger is the truth.

## Before you finish

Run the targets for what you touched: `npx nx run-many -t typecheck,test,build -p <projects>` (the web app type-checks during `build`), and `npx eslint <paths>`. A change to `loop.ts` should keep every existing trace and event identical unless the behaviour change is the point.
