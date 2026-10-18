# agenticbot

Personal **agent harness** in an [Nx](https://nx.dev) monorepo: a host-agnostic runtime (`@org/agent-core`), Express API with SSE (`apps/api`), Next.js chat UI (`apps/web`), and a CLI eval harness (`apps/agent`). The goal is a **single-turn research experience**—deep, cited answers when tools are used, without unnecessary web calls for general knowledge.

For Nx-specific conventions (tasks, generators, MCP), see [AGENTS.md](./AGENTS.md). For Cursor/agent context, see [.cursor/rules/agenticbot-system.mdc](./.cursor/rules/agenticbot-system.mdc).

---

## Architecture

| Layer          | Package / app       | Responsibility                                                                               |
| -------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| Domain types   | `@org/agent-models` | `Run`, `Thread`, `AgentEvent`, `RESEARCH_MODE`, chat shapes                                  |
| Runtime (pure) | `@org/agent-core`   | `runLoop`, `RunManager`, tools, model invoke/stream, system prompt — **no HTTP, DOM, or DB** |
| Transport      | `apps/api`          | Express: `/api/agent/*`, disk thread store, voice STT proxy                                  |
| UI             | `apps/web`          | Chat UI + SSE via `use-agent-run` (threads from API catalog)                                 |
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

**Threads are host-owned on disk** (`AGENTICBOT_HOME` SQLite catalog + ledger). The first user turn seeds a sidebar title and refines it with the chat model.

**One active run per thread** (enforced in API). Use `POST /api/agent/run/:runId/cancel` to stop generation.

### Tool policy (important)

Tools are registered in `@org/agent-core` and filtered per run:

| Tool         | When available                                                                             | Purpose                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_search` | Only if the client enables **Web search** in the composer (`allowedTools: ['web_search']`) | Live search via a provider chain (Ollama if keyed; else Firecrawl keyless → Tavily keyless). Tiered results: rich hits skip a second fetch; short snippets auto-fetch top **2** URLs; remaining hits are **Further Reading**. |
| `web_fetch`  | **Always** (server `globalTools`)                                                          | Fetch a single URL (same provider chain) — user pasted links or deeper read from search.                                                                                                                                      |
| `load_skill` | **Always** (server `globalTools`)                                                          | Optional skill packs. `web_search` / `web_fetch` work without loading a skill.                                                                                                                                                |

**Resource discipline (by design):**

- General knowledge, math, coding without live data → **no** `web_search`.
- `web_search` is not “always on”; the UI toggle controls whether it is in the allow list.
- `web_fetch` does not imply searching; use it for URLs and selective deep reads.

Mode defaults live in `packages/agent/models/src/lib/mode.ts` (`RESEARCH_MODE`: `allowedTools`, `globalTools`, limits).

---

## Prerequisites

- **Node.js** 20+ (LTS recommended)
- **npm** (root `package.json` `workspaces` + `package-lock.json`)
- **Ollama** for chat: cloud API key and/or local `OLLAMA_BASE_URL` ([docs](https://docs.ollama.com))
- **Web search** works with **no search API key** (Firecrawl keyless → Tavily keyless). Optional `OLLAMA_API_KEY` / `FIRECRAWL_API_KEY` / `TAVILY_API_KEY` for higher limits — see env table
- **Redis** (optional but required for async **thread title** jobs): local Docker or existing instance — see [docker/README.md](./docker/README.md)
- **Voice STT** (optional): default **browser** Web Speech API; optional **Speaches** via Docker — see env table + [docker/README.md](./docker/README.md)

Ollama **chat** uses the OpenAI-compatible endpoint (`OLLAMA_BASE_URL=https://ollama.com/v1`). Web search/fetch are routed in `packages/agent/core/src/lib/tools/web_search_api.ts`: with `OLLAMA_API_KEY`, Ollama cloud search/fetch; otherwise Firecrawl keyless then Tavily keyless. Keyless tiers are shared / rate-limited — not a production SLA.

---

## Environment

Copy and fill secrets (never commit `.env`):

```bash
cp .env.example .env
```

Host-run API (typical dev) — see [.env.example](./.env.example):

| Variable                         | Purpose                                                       |
| -------------------------------- | ------------------------------------------------------------- |
| `OLLAMA_BASE_URL`                | Chat completions base URL (default cloud)                     |
| `OLLAMA_API_KEY`                 | Chat (cloud) + forces Ollama web search/fetch when set        |
| `FIRECRAWL_API_KEY`              | Optional — higher Firecrawl limits (keyless works without it) |
| `TAVILY_API_KEY`                 | Optional — higher Tavily limits (keyless works without it)    |
| `AGENTICBOT_HOME`                | Session catalog/ledger root (default `~/.local/agenticbot`)   |
| `VOICE_STT_PROVIDER`             | `browser` (default) \| `speaches` \| `off`                    |
| `NEXT_PUBLIC_VOICE_STT_PROVIDER` | Same value for the web app (must match)                       |
| `SPEACHES_BASE_URL`              | Speaches only — STT proxy base URL                            |
| `SPEACHES_STT_MODEL`             | Speaches only — e.g. distil-whisper-large-v3                  |
| `VOICE_STT_LANGUAGE`             | Speaches `language` (default `en`)                            |
| `VOICE_STT_PROMPT`               | Speaches vocabulary hint                                      |

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

### Verify web search APIs (CLI)

Keyless (no account) — Firecrawl then Tavily:

```bash
# Firecrawl keyless search + scrape
curl -s -X POST https://api.firecrawl.dev/v2/search \
  -H "Content-Type: application/json" \
  -d '{"query":"Firecrawl search API","limit":3,"scrapeOptions":{"formats":["markdown","links"]}}'

# Tavily keyless search
curl -s -X POST https://api.tavily.com/search \
  -H "Content-Type: application/json" \
  -H "X-Tavily-Access-Mode: keyless" \
  -d '{"query":"Tavily search API","max_results":3}'
```

Optional Ollama (requires `OLLAMA_API_KEY`):

```bash
curl -s https://ollama.com/api/web_search \
  -H "Authorization: Bearer $OLLAMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"Ollama web search API","max_results":3}'
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
| Web search/fetch router | `packages/agent/core/src/lib/tools/web_search_api.ts`          |
| Search providers        | `packages/agent/core/src/lib/tools/web-search-providers.ts`    |
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

| Method | Path                                     | Description                                                             |
| ------ | ---------------------------------------- | ----------------------------------------------------------------------- |
| `POST` | `/api/agent/run`                         | Append optional user turn, start run; first turn also titles the thread |
| `GET`  | `/api/agent/run/:runId/events?fromSeq=N` | SSE stream of `AgentEvent`s                                             |
| `POST` | `/api/agent/run/:runId/cancel`           | Cancel in-flight run                                                    |
| `*`    | `/api/agent/threads…`                    | Disk-backed thread catalog / ledger                                     |

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
| `web_search` fails                     | Keyless Firecrawl/Tavily 429 (shared caps); or `OLLAMA_API_KEY` path — curl tests above                 |
| `web_fetch` fails                      | Valid full URL; provider rate limit; page blocked or huge (content truncated at 4k chars in harness)    |
| Run stuck “running”                    | SSE disconnect; `run.completed` / `run.error`; cancel endpoint                                          |
| 409 on new message                     | Prior run still active on thread; cancel or wait                                                        |
| Title stays “New Chat”                 | First message must go through `POST /run`; check API logs for `[title] generate failed`                 |
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

Implementation in `web_search_api.ts` + `web-search-providers.ts`:

1. **Provider router:** `OLLAMA_API_KEY` → Ollama only; else Firecrawl keyless, then Tavily keyless on retryable failure (429 / 5xx / empty / network). Failover is inside the tool — not a second model `web_search`.
2. One search (default **5** results). Hits that already include long scraped/chunked content skip a second fetch.
3. **Auto-fetch** only for short snippets on the top **2** URLs; truncate page body at 4k chars.
4. Return **Detailed Sources** + **Further Reading**. Model may `web_fetch` a listed URL if needed — do not re-search the same question.

System prompt (`system-prompt.ts`) instructs: answer from stable knowledge without tools; synthesize one comprehensive reply when tools are used; cite URLs; do not loop on poor searches.

---

## Further reading

- [Ollama web search & fetch](https://docs.ollama.com/capabilities/web-search)
- [Firecrawl search](https://docs.firecrawl.dev/features/search) (keyless search/scrape)
- [Tavily keyless](https://docs.tavily.com/documentation/keyless)
- [Nx documentation](https://nx.dev/docs)
- [Docker stack (Redis, Speaches)](./docker/README.md)
