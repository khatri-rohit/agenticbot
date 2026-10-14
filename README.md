# agenticbot

Personal **agent harness** in an [Nx](https://nx.dev) monorepo: a host-agnostic runtime (`@org/agent-core`), Express API with SSE (`apps/api`), Next.js chat UI (`apps/web`), and a CLI eval harness (`apps/agent`). The goal is a **single-turn research experience**—deep, cited answers when tools are used, without unnecessary web calls for general knowledge.

For Nx-specific conventions (tasks, generators, MCP), see [AGENTS.md](./AGENTS.md). For Cursor/agent context, see [.cursor/rules/agenticbot-system.mdc](./.cursor/rules/agenticbot-system.mdc).

---

## Architecture

| Layer          | Package / app       | Responsibility                                                                               |
| -------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| Domain types   | `@org/agent-models` | `Run`, `Thread`, `AgentEvent`, `RESEARCH_MODE`, chat shapes                                  |
| Runtime (pure) | `@org/agent-core`   | `runLoop`, `RunManager`, tools, model invoke/stream, system prompt — **no HTTP, DOM, or DB** |
| Transport      | `apps/api`          | Express: `/api/agent/*`, voice STT proxy, BullMQ title jobs                                  |
| UI             | `apps/web`          | Chat, IndexedDB threads, SSE via `use-agent-run`                                             |
| Local eval     | `apps/agent`        | Thin script calling core directly                                                            |

### Request flow (chat)

```
User message (apps/web)
  → POST /api/agent/run  { threadId, messages, allowedTools?, model?, streaming?, thinking? }
  → createToolRegistry(ALL_TOOLS, clientTools ∪ globalTools)
  → RunManager.start → runLoop(modelCall, messages, tools)
  → GET /api/agent/run/:runId/events  (SSE AgentEvents)
  → apps/web chat-store reducer → UI
```

**Server is stateless for threads:** the client sends full message history each run. Threads live in the browser (IndexedDB).

**One active run per thread** (enforced in API). Use `POST /api/agent/run/:runId/cancel` to stop generation.

### Tool policy (important)

Tools are registered in `@org/agent-core` and filtered per run:

| Tool         | When available                                                                             | Purpose                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_search` | Only if the client enables **Web search** in the composer (`allowedTools: ['web_search']`) | Live search via [Ollama web search API](https://docs.ollama.com/capabilities/web-search). Tiered results: auto-fetches top **2** result URLs for full content; remaining hits are **Further Reading** snippets. |
| `web_fetch`  | **Always** (server `globalTools`)                                                          | Fetch a single URL via Ollama `web_fetch` — user pasted links or deeper read from search.                                                                                                                       |
| `load_skill` | **Always** (server `globalTools`)                                                          | Load harness skill instructions (e.g. `web_search_skill`) before complex tool use.                                                                                                                              |

**Resource discipline (by design):**

- General knowledge, math, coding without live data → **no** `web_search`.
- `web_search` is not “always on”; the UI toggle controls whether it is in the allow list.
- `web_fetch` does not imply searching; use it for URLs and selective deep reads.

Mode defaults live in `packages/agent/models/src/lib/mode.ts` (`RESEARCH_MODE`: `allowedTools`, `globalTools`, limits).

---

## Prerequisites

- **Node.js** 20+ (LTS recommended)
- **npm** (root `package.json` `workspaces` + `package-lock.json`)
- **Ollama cloud** API key for chat + web search/fetch ([docs](https://docs.ollama.com/capabilities/web-search))
- **Redis** (optional but required for async **thread title** jobs): local Docker or existing instance — see [docker/README.md](./docker/README.md)
- **Voice STT** (optional): default **browser** Web Speech API; optional **Speaches** via Docker — see env table + [docker/README.md](./docker/README.md)

Ollama **chat** uses the OpenAI-compatible endpoint (`OLLAMA_BASE_URL=https://ollama.com/v1`). Web search/fetch use `https://ollama.com/api/web_search` and `web_fetch` with `OLLAMA_API_KEY` (see `packages/agent/core/src/lib/tools/web_search_api.ts`).

---

## Environment

Copy and fill secrets (never commit `.env`):

```bash
cp .env.example .env
```

Host-run API (typical dev) — see [.env.example](./.env.example):

| Variable                         | Purpose                                       |
| -------------------------------- | --------------------------------------------- |
| `OLLAMA_BASE_URL`                | Chat completions base URL (default cloud)     |
| `OLLAMA_API_KEY`                 | Chat + Ollama web search/fetch                |
| `REDIS_URL`                      | BullMQ title queue (`redis://127.0.0.1:6379`) |
| `VOICE_STT_PROVIDER`             | `browser` (default) \| `speaches` \| `off`    |
| `NEXT_PUBLIC_VOICE_STT_PROVIDER` | Same value for the web app (must match)       |
| `SPEACHES_BASE_URL`              | Speaches only — STT proxy base URL            |
| `SPEACHES_STT_MODEL`             | Speaches only — e.g. distil-whisper-large-v3  |
| `VOICE_STT_LANGUAGE`             | Speaches `language` (default `en`)            |
| `VOICE_STT_PROMPT`               | Speaches vocabulary hint                      |

Web app (optional override):

| Variable               | Purpose                                      |
| ---------------------- | -------------------------------------------- |
| `NEXT_PUBLIC_API_BASE` | API origin (default `http://localhost:3333`) |

Docker-only overrides: [.env.docker.example](./.env.docker.example) — see [docker/README.md](./docker/README.md). **Compose does not run Ollama**; it provides Redis + Speaches.

---

## Quick start (development)

```bash
# Install (from repo root)
npm install

# Infrastructure (Redis + Speaches, CPU profile)
docker compose --profile cpu up -d
# Optional: docker compose --env-file .env.docker up -d

# Terminal 1 — API (port 3333)
npx nx run @org/api:serve

# Terminal 2 — Web (Next.js)
npx nx run @org/web:dev
```

Open the web app URL printed by Next (often `http://localhost:4200` or `3000` — check Nx output).

### Verify Ollama web APIs (CLI)

Requires `OLLAMA_API_KEY` in the environment:

```bash
# Web search
curl -s https://ollama.com/api/web_search \
  -H "Authorization: Bearer $OLLAMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"Ollama web search API","max_results":3}'

# Web fetch (example)
curl -s https://ollama.com/api/web_fetch \
  -H "Authorization: Bearer $OLLAMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://docs.ollama.com/capabilities/web-search"}'
```

---

## Nx commands (agent stack)

Use `npx nx` (npm workspaces + package-lock.json):

```bash
# Typecheck / build affected libs after changing agent packages
npx nx run @org/agent-core:typecheck
npx nx run @org/agent-models:typecheck
npx nx run @org/api:typecheck
npx nx run @org/web:lint

npx nx run @org/agent-core:build
npx nx run @org/api:build
npx nx run @org/web:build

# Lint / test (as configured)
npx nx affected -t typecheck build lint test
```

### Typecheck troubleshooting

- Apps reference built **`.d.ts`** from `packages/agent/*/dist` via TypeScript project references. After changing `@org/agent-models` types (e.g. `ModeConfig.globalTools`), rebuild declarations:

  ```bash
  node node_modules/typescript/bin/tsc -p packages/agent/models/tsconfig.lib.json
  node node_modules/typescript/bin/tsc -p packages/agent/core/tsconfig.lib.json
  ```

- If `npx nx` fails with missing `nx`/`typescript` under `node_modules`, run `npm install` again.

---

## Key file map (agent harness)

| Area                    | Path                                                           |
| ----------------------- | -------------------------------------------------------------- |
| Core exports            | `packages/agent/core/src/index.ts`                             |
| Agent loop              | `packages/agent/core/src/lib/loop/loop.ts`                     |
| Loop limits             | `packages/agent/core/src/lib/loop/limits.ts`                   |
| Run manager + cancel    | `packages/agent/core/src/lib/run/run-manager.ts`               |
| Tool registry           | `packages/agent/core/src/lib/tools/registry.ts`                |
| Ollama web search/fetch | `packages/agent/core/src/lib/tools/web_search_api.ts`          |
| Tool definitions        | `packages/agent/core/src/lib/tools/web-search.ts`, `skills.ts` |
| System prompt           | `packages/agent/core/src/lib/prompts/system-prompt.ts`         |
| Research mode           | `packages/agent/models/src/lib/mode.ts`                        |
| API routes              | `apps/api/src/routes/agent/agent.routes.ts`                    |
| Voice STT proxy         | `apps/api/src/routes/voice/voice.routes.ts`                    |
| Web SSE client          | `apps/web/src/features/agent/api/agent-client.ts`              |
| Web run hook            | `apps/web/src/features/agent/hooks/use-agent-run.ts`           |
| Event → UI state        | `apps/web/src/features/agent/store/chat-store.ts`              |

---

## API surface (agent)

| Method | Path                                     | Description                                                                                                |
| ------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/agent/run`                         | Start run; body includes `threadId`, `messages`, optional `allowedTools`, `model`, `streaming`, `thinking` |
| `GET`  | `/api/agent/run/:runId/events?fromSeq=N` | SSE stream of `AgentEvent`s                                                                                |
| `POST` | `/api/agent/run/:runId/cancel`           | Cancel in-flight run                                                                                       |
| `POST` | `/api/agent/title`                       | Enqueue title generation (needs Redis)                                                                     |
| `GET`  | `/api/agent/title/:jobId`                | Poll title job                                                                                             |

Client tool wiring (`apps/web/src/features/agent/api/agent-client.ts`):

- `webSearch === false` → `allowedTools: []` (only **global** tools remain: `web_fetch`, `load_skill`).
- `webSearch === true` (default) → `allowedTools: ['web_search']` plus globals.

---

## Adding or changing tools (implementation guide)

1. **Define the tool** in `@org/agent-core` (`Tool`: OpenAI `definition`, `guidance`, `execute`).
2. **Register** in `ALL_TOOLS` (`packages/agent/core/src/lib/tools/registry.ts`).
3. **Expose to the model** via mode policy:
   - User-toggleable → `RESEARCH_MODE.allowedTools` and/or client `allowedTools`.
   - Always on → `RESEARCH_MODE.globalTools` (merged in `agent.routes.ts`).
4. **System prompt** — per-tool guardrails are injected from `guidance` in `buildSystemPrompt()`. Add policy in `system-prompt.ts` only when it is cross-tool behavior (e.g. research synthesis).
5. **UI** — tool lifecycle events (`tool.started` / `completed` / `failed`) are generic in `chat-store.ts`; no change needed unless you add new event types.
6. **Validate** — `npx nx run @org/agent-core:typecheck` and `@org/api:typecheck`.

External HTTP for tools belongs in core modules (e.g. `web_search_api.ts`), not in Express routes.

---

## Debugging checklist

| Symptom                                | Things to check                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| No tools / wrong tools                 | Request body `allowedTools`; server merge with `RESEARCH_MODE.globalTools`; `createToolRegistry` filter |
| `web_search` fails                     | `OLLAMA_API_KEY` set for API process; curl test above; rate limits on Ollama cloud                      |
| `web_fetch` fails                      | Valid full URL; same API key; page blocked or huge (content truncated at 4k chars in harness)           |
| Run stuck “running”                    | SSE disconnect; `run.completed` / `run.error`; cancel endpoint                                          |
| 409 on new message                     | Prior run still active on thread; cancel or wait                                                        |
| Title never updates                    | `REDIS_URL`, Redis up, title worker/queue in API logs                                                   |
| Voice / STT errors                     | Speaches health `http://127.0.0.1:8000/health`, model pull per [docker/README.md](./docker/README.md)   |
| Type errors in API after model changes | Rebuild `packages/agent/models` and `core` `.d.ts` (see above)                                          |

Enable API logging around agent routes and watch SSE in browser devtools (Network → EventStream).

---

## Repository layout (high level)

```
agenticbot/
├── apps/
│   ├── api/          # Express — agent, voice
│   ├── web/          # Next.js chat UI
│   ├── agent/        # CLI harness
│   └── *-e2e/
├── packages/
│   └── agent/
│       ├── core/     # @org/agent-core — loop, tools, model
│       └── models/   # @org/agent-models — types, RESEARCH_MODE

├── docker/           # Compose docs
├── docker-compose.yml
├── .cursor/skills/   # Nx workspace skills for agents
├── AGENTS.md
└── .env.example
```

---

## Design notes (web search behavior)

Implementation in `web_search_api.ts`:

1. Call Ollama `web_search` (default 5 results, each with `title`, `url`, `content` snippet).
2. **Auto-fetch** full pages for the top **2** URLs (`web_fetch`), truncate page body for context size.
3. Return formatted markdown-like text: **Detailed Sources** + **Further Reading** (snippets + links).
4. Model may call **`web_fetch`** on a Further Reading URL if the answer still needs depth.

System prompt (`system-prompt.ts`) instructs: answer from stable knowledge without tools; synthesize one comprehensive reply when tools are used; cite URLs; do not loop on poor searches.

---

## Further reading

- [Ollama web search & fetch](https://docs.ollama.com/capabilities/web-search)
- [Nx documentation](https://nx.dev/docs)
- [Docker stack (Redis, Speaches)](./docker/README.md)
