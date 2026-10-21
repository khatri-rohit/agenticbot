# Desk

Personal **agent harness** in an [Nx](https://nx.dev) monorepo: a host-agnostic runtime (`@desk/agent-core`), Express API with SSE (`apps/api`), Next.js chat UI (`apps/web`), and a CLI eval harness (`apps/agent`). One engine, two bindings: **Home** (chat, optional web) and **Workspace** (folder-bound coding tools).

For Nx-specific conventions (tasks, generators, MCP), see [AGENTS.md](./AGENTS.md). For Cursor/agent context, see [.cursor/rules/desk-system.mdc](./.cursor/rules/desk-system.mdc).

---

## Architecture

| Layer          | Package / app        | Responsibility                                                                               |
| -------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| Domain types   | `@desk/agent-models` | `Run`, `Thread`, `AgentEvent`, `HOME_MODE` / `WORKSPACE_MODE`, chat shapes                   |
| Runtime (pure) | `@desk/agent-core`   | `runLoop`, `RunManager`, tools, model invoke/stream, system prompt — **no HTTP, DOM, or DB** |
| Transport      | `apps/api`           | Express: `/api/agent/*`, disk thread store, voice STT proxy                                  |
| UI             | `apps/web`           | Chat UI + SSE via `use-agent-run` (threads from API catalog)                                 |
| Local eval     | `apps/agent`         | Thin script calling core directly                                                            |

### Request flow (chat)

```
User message (apps/web)
  → POST /api/agent/run  { threadId, messages, allowedTools?, model?, thinking? }
  → createToolRegistry(ALL_TOOLS, clientTools ∪ globalTools)
  → RunManager.start → runLoop(modelCall, messages, tools)
  → GET /api/agent/run/:runId/events  (SSE AgentEvents)
  → apps/web chat-store reducer → UI
```

**Threads are host-owned on disk** (`DESK_HOME` SQLite catalog + per-thread `ledger.jsonl`). The first user turn seeds a sidebar title and refines it with the chat model. The ledger is the durable history of the **active tape**. Retry/edit **rewind** truncates that tape (atomic rewrite) — discarded turns are gone. SSE is a live convenience; after a run handle is cleared (5 minute TTL) a late events subscribe is 404 and the client rebuilds from `GET /ledger`.

**One active run per thread** (enforced in API). **One agent-posture run per workspace folder** (409 `reason: 'workspace'`); ask-posture and Home threads are exempt. Both mutexes are **in-process** (`RunManager` singleton) — not multi-instance. Use `POST /api/agent/run/:runId/cancel` to stop generation.

### Harness mental models

How to think about this system when changing it or prompting it. (Response branching is not in the tree; rewind stays.)

1. **The loop is a budget machine.** Home caps iterations and tool calls; Workspace omits those caps and relies on the repeat detector, tool timeouts, cancel, and context residency (`packages/agent-core/src/lib/loop/limits.ts`). Tune budgets and residency when the model loops — almost never the system prompt.

2. **Context is a cache; stubbing is eviction.** `assembleContext` evicts by role: old tool results stub first, old image attachments stub next (`keepAttachmentsForTurns`), large bodies spill to blobs, the tape compact last. Judge new capabilities by cache residency.

3. **The gate is the constitution; the model is a petitioner.** Memory writes, posture, and the workspace path jail are deterministic (`packages/agent-core/src/lib/memory/gate.ts`). Same input → same verdict. Ship the gate in the same change as the capability. Write/exec tools run without an Allow/Deny pause.

4. **Events are the product; the ledger is the truth; SSE is a convenience.** `AgentEvent` is the live API. Any UI state that cannot be rebuilt from `GET /ledger` is a bug. A seq gap on the stream refetches the ledger (`use-agent-run`).

5. **Determinism is load-bearing.** Everything except the model is deterministic. Compaction is extractive (no LLM on the request path). Model calls belong in maintenance (thread title), not admission or assembly.

### Tool policy (important)

Tools are registered in `@desk/agent-core` and filtered per run:

| Tool         | When available                                                                             | Purpose                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_search` | Only if the client enables **Web search** in the composer (`allowedTools: ['web_search']`) | Live search: Ollama → Firecrawl → Tavily. Returns **hit cards**; top **2** hits are prefetched into the source store (`sha256`).                                            |
| `web_fetch`  | **Always** (Home and Workspace `globalTools`)                                              | `url` → fetch pipeline (Ollama → Firecrawl → Tavily → **local HTTP**), store full page, return a **card** (~2k teaser). `sha256`+`offset`+`limit` → page the stored source. |
| `load_skill` | **Always** (server `globalTools`)                                                          | Optional skill packs. `web_search` / `web_fetch` work without loading a skill.                                                                                              |

**Resource discipline (by design):**

- General knowledge, math, coding without live data → **no** `web_search`.
- `web_search` is not “always on”; the UI toggle controls whether it is in the allow list.
- `web_fetch` does not imply searching; use it for URLs and selective deep reads.

Profile defaults live in `packages/agent-models/src/lib/mode.ts` (`HOME_MODE` / `WORKSPACE_MODE`: `allowedTools`, `globalTools`, limits).

---

## Prerequisites

- **Node.js** 20+ (LTS recommended)
- **npm** (root `package.json` `workspaces` + `package-lock.json`)
- **Ollama** for chat: cloud API key and/or local `OLLAMA_BASE_URL` ([docs](https://docs.ollama.com))
- **Web search/fetch** always run the same layered pipeline (Ollama → Firecrawl → Tavily; fetch then **local HTTP**). Keys are credentials for a layer, not a router. Firecrawl/Tavily keyless still work without a dedicated search key.
- **Redis** (optional but required for async **thread title** jobs): local Docker or existing instance — see [docker/README.md](./docker/README.md)
- **Voice STT** (optional): default **browser** Web Speech API; optional **Speaches** via Docker — see env table + [docker/README.md](./docker/README.md)

Ollama **chat** uses the OpenAI-compatible endpoint (`OLLAMA_BASE_URL=https://ollama.com/v1`). Web tools are independent of which model is chatting: `web_search_api.ts` tries Ollama, then Firecrawl, then Tavily; `web_fetch` then tries local HTTP. Keyless Firecrawl/Tavily tiers are shared / rate-limited — not a production SLA.

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
| `OLLAMA_API_KEY`                 | Chat (cloud) + first web search/fetch layer when set          |
| `FIRECRAWL_API_KEY`              | Optional — higher Firecrawl limits (keyless works without it) |
| `TAVILY_API_KEY`                 | Optional — higher Tavily limits (keyless works without it)    |
| `DESK_HOME`                      | Session catalog/ledger root (default `~/.local/desk`)         |
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
npx nx run @desk/api:serve

# Terminal 2 — Web (Next.js)
npx nx run @desk/web:dev
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
npx nx run @desk/agent-core:typecheck
npx nx run @desk/agent-models:typecheck
npx nx run @desk/api:typecheck
npx nx run @desk/web:lint

npx nx run @desk/agent-core:build
npx nx run @desk/api:build
npx nx run @desk/web:build

# Lint / test (as configured)
npx nx affected -t typecheck build lint test
```

### Typecheck troubleshooting

- Apps reference built **`.d.ts`** from `packages/agent-*/dist` via TypeScript project references. After changing `@desk/agent-models` types (e.g. `ModeConfig.globalTools`), rebuild declarations:

  ```bash
  node node_modules/typescript/bin/tsc -p packages/agent-models/tsconfig.lib.json
  node node_modules/typescript/bin/tsc -p packages/agent-core/tsconfig.lib.json
  ```

- If `npx nx` fails with missing `nx`/`typescript` under `node_modules`, run `npm install` again.

---

## Key file map (agent harness)

| Area                      | Path                                                           |
| ------------------------- | -------------------------------------------------------------- |
| Core exports              | `packages/agent-core/src/index.ts`                             |
| Agent loop                | `packages/agent-core/src/lib/loop/loop.ts`                     |
| Loop limits               | `packages/agent-core/src/lib/loop/limits.ts`                   |
| Run manager + cancel      | `packages/agent-core/src/lib/run/run-manager.ts`               |
| Tool registry             | `packages/agent-core/src/lib/tools/registry.ts`                |
| Web search/fetch router   | `packages/agent-core/src/lib/tools/web_search_api.ts`          |
| Search providers          | `packages/agent-core/src/lib/tools/web-search-providers.ts`    |
| Tool definitions          | `packages/agent-core/src/lib/tools/web-search.ts`, `skills.ts` |
| System prompt             | `packages/agent-core/src/lib/prompts/system-prompt.ts`         |
| Home / Workspace profiles | `packages/agent-models/src/lib/mode.ts`                        |
| API routes                | `apps/api/src/routes/agent/agent.routes.ts`                    |
| Voice STT proxy           | `apps/api/src/routes/voice/voice.routes.ts`                    |
| Web SSE client            | `apps/web/src/features/agent/api/agent-client.ts`              |
| Web run hook              | `apps/web/src/features/agent/hooks/use-agent-run.ts`           |
| Event → UI state          | `apps/web/src/features/agent/store/chat-store.ts`              |

---

## API surface (agent)

| Method | Path                                     | Description                                                             |
| ------ | ---------------------------------------- | ----------------------------------------------------------------------- |
| `POST` | `/api/agent/run`                         | Append optional user turn, start run; first turn also titles the thread |
| `GET`  | `/api/agent/run/:runId/events?fromSeq=N` | SSE stream of `AgentEvent`s                                             |
| `POST` | `/api/agent/run/:runId/cancel`           | Cancel in-flight run                                                    |
| `*`    | `/api/agent/threads…`                    | Disk-backed thread catalog / ledger                                     |

Client tool wiring (`apps/web/src/features/agent/api/agent-client.ts`):

- Home: `web_fetch`, `load_skill`, `memory`; `web_search` when the client leaves web search on.
- Workspace: `glob`, `grep`, `read_file`, `edit_file`, `run_terminal`, `load_skill`, `memory` (no default web search).

---

## Adding or changing tools (implementation guide)

1. **Define the tool** in `@desk/agent-core` (`Tool`: OpenAI `definition`, `guidance`, `execute`).
2. **Register** in `ALL_TOOLS` (`packages/agent-core/src/lib/tools/registry.ts`).
3. **Expose to the model** via profile policy:
   - User-toggleable → `HOME_MODE.allowedTools` and/or client `allowedTools`.
   - Always on → `HOME_MODE.globalTools` or `WORKSPACE_MODE.globalTools` (merged in `agent.routes.ts`).
4. **System prompt** — per-tool guardrails are injected from `guidance` in `buildSystemPrompt()`. Add policy in `system-prompt.ts` only when it is cross-tool behavior.
5. **UI** — tool lifecycle events (`tool.started` / `completed` / `failed`) are generic in `chat-store.ts`; no change needed unless you add new event types.
6. **Validate** — `npx nx run @desk/agent-core:typecheck` and `@desk/api:typecheck`.

External HTTP for tools belongs in core modules (e.g. `web_search_api.ts`), not in Express routes.

---

## Debugging checklist

| Symptom                                | Things to check                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| No tools / wrong tools                 | Request body `allowedTools`; server merge with profile `globalTools`; `createToolRegistry` filter              |
| `web_search` fails                     | Keyless Firecrawl/Tavily 429 (shared caps); or `OLLAMA_API_KEY` path — curl tests above                        |
| `web_fetch` fails                      | Valid public http(s) URL; all scrape layers + local HTTP failed; huge pages are prefixed at 16k chars          |
| Run stuck “running”                    | SSE disconnect; seq gap should refetch ledger; `run.settled` / `run.error`; cancel endpoint                    |
| 409 on new message                     | Thread already running, or another **agent** run in the same workspace (`reason: 'workspace'`); cancel or wait |
| Title stays “New Chat”                 | First message must go through `POST /run`; check API logs for `[title] generate failed`                        |
| Voice / STT errors                     | Speaches health `http://127.0.0.1:8000/health`, model pull per [docker/README.md](./docker/README.md)          |
| Type errors in API after model changes | Rebuild `packages/agent-models` and `core` `.d.ts` (see above)                                                 |

Enable API logging around agent routes and watch SSE in browser devtools (Network → EventStream).

---

## Repository layout (high level)

```
desk/
├── apps/
│   ├── api/              # Express — agent, voice
│   ├── web/              # Next.js chat UI
│   └── agent/            # CLI / eval harness
├── packages/
│   ├── agent-core/       # @desk/agent-core — loop, tools, model
│   └── agent-models/     # @desk/agent-models — types, HOME_MODE / WORKSPACE_MODE
├── docker/               # Compose docs
├── docker-compose.yml
├── LICENSE
├── .cursor/rules/        # Shared agent context
├── AGENTS.md
└── .env.example
```

---

## Design notes (web search behavior)

Implementation in `web_search_api.ts` + `web-search-providers.ts`:

1. **Fixed pipeline:** search = Ollama → Firecrawl → Tavily. Fetch = those scrape layers, then **local HTTP**. Failover is inside the tool. Thin bodies continue.
2. **Store vs view:** full page text is stored (run cache + thread `putBlob`). The model sees a **source card** (~2k teaser + headings + `sha256`), then pages with `web_fetch { sha256, offset, limit }`.
3. **Search** returns hit cards; top **2** URLs are prefetched into the store (not dumped into the prompt).
4. Same-URL refetch (hash / reader proxy) is a repeated tool call; prefer sha paging.
5. **Untrusted web:** teaser/slices wrapped as `UNTRUSTED_WEB_*`. URL allowlist + sha allowlist (sources from this run only). Local HTTP re-checks private hosts after redirects. `run_terminal` refuses curl/wget/IRW.

System prompt (`system-prompt.ts`) instructs: answer from stable knowledge without tools; synthesize one comprehensive reply when tools are used; cite URLs; do not loop on poor searches.

---

## Further reading

- [Ollama web search & fetch](https://docs.ollama.com/capabilities/web-search)
- [Firecrawl search](https://docs.firecrawl.dev/features/search) (keyless search/scrape)
- [Tavily keyless](https://docs.tavily.com/documentation/keyless)
- [Nx documentation](https://nx.dev/docs)
- [Docker stack (Redis, Speaches)](./docker/README.md)
