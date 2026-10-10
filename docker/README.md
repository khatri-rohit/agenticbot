# Docker infrastructure (agenticbot)

Compose stack for **Redis** (BullMQ) and **Speaches** (STT: **faster-distil-whisper-large-v3**).

**Ollama is not part of this compose file.** Chat stays on cloud via host `.env` (`OLLAMA_BASE_URL=https://ollama.com/v1`). Your existing Ollama container and model directory (e.g. `D:\ollama\models`) are never mounted, created, replaced, or deleted by `docker compose up` / `down` / `down -v`.

## What Compose owns vs leaves alone

| Path / service                                           | Owned by this compose?        |
| -------------------------------------------------------- | ----------------------------- |
| Redis data (`redis-data` or your Redis bind)             | Yes                           |
| Speaches HF cache (`speaches-hf-cache` or Speaches bind) | Yes — speech models only      |
| Ollama models (e.g. `D:\ollama\models`)                  | **No — never referenced**     |
| Standalone `ollama` container on `:11434`                | **No — leave running as-is**  |
| Host `.env` `OLLAMA_*` for apps/api                      | **No — cloud chat unchanged** |

## Portability (open source)

Committed defaults use **Docker named volumes** (`redis-data`, `speaches-hf-cache`). Works on **macOS, Linux, and Windows**.

| Layer                         | In git?             | Purpose                           |
| ----------------------------- | ------------------- | --------------------------------- |
| `docker-compose.yml`          | Yes                 | Portable defaults (named volumes) |
| `.env.docker.example`         | Yes                 | Documented optional overrides     |
| `.env.docker`                 | **No** (gitignored) | Your machine paths / ports        |
| `docker-compose.override.yml` | **No** (gitignored) | Optional personal binds           |

**Contributors:** `docker compose --profile cpu up -d` — no `.env.docker` required.

Optional Windows D: binds for Redis / Speaches only (never Ollama):

```env
REDIS_DATA_DIR=D:/agenticbot/docker-data/redis
SPEACHES_HF_CACHE_DIR=D:/agenticbot/docker-data/speaches/hf-hub
```

Compose rule: a **bare name** → named volume; an **absolute path** → host bind mount.

## Your machine (snapshot from Docker CLI)

| Check                    | Result                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| Docker Desktop           | 4.83.0, Engine 29.6.2, Compose v5.3.1                                                    |
| Memory limit (Docker VM) | **~7.75 GiB** — raise if Speaches preload OOMs                                           |
| NVIDIA in Docker         | Not working yet — use **`COMPOSE_PROFILES=cpu`**                                         |
| Existing Ollama          | Separate container; **`D:\ollama\models` untouched by this stack**                       |
| Existing Redis           | `colorcaratiers-dev-redis-1` on **127.0.0.1:6379** — stop it or change `REDIS_HOST_PORT` |

## Optional: Windows D: binds (Redis + Speaches only)

```powershell
New-Item -ItemType Directory -Force -Path D:\agenticbot\docker-data\redis
New-Item -ItemType Directory -Force -Path D:\agenticbot\docker-data\speaches\hf-hub
```

Do **not** set Speaches or Redis paths to `D:\ollama\models`.

## Start / stop

```bash
docker compose --profile cpu up -d
# or: docker compose --env-file .env.docker up -d

curl -s http://127.0.0.1:8000/health
docker exec agenticbot-redis redis-cli ping

# Stop stack — Ollama models dir is not involved
docker compose down
```

`down -v` only removes **this project’s** named volumes (`redis-data`, `speaches-hf-cache`). It cannot remove `D:\ollama\models` because that path is not in the compose file.

## Profiles: CPU vs GPU (Speaches)

| Profile | Service        | Image         | When                         |
| ------- | -------------- | ------------- | ---------------------------- |
| `cpu`   | `speaches`     | `latest-cpu`  | Default                      |
| `gpu`   | `speaches-gpu` | `latest-cuda` | After NVIDIA works in Docker |

## App wiring (host-run API / web)

```env
REDIS_URL=redis://127.0.0.1:6379
SPEACHES_BASE_URL=http://127.0.0.1:8000
SPEACHES_STT_MODEL=Systran/faster-distil-whisper-large-v3
# Keep chat on cloud — do not point OLLAMA_BASE_URL at Compose
```

Voice transcribe proxy (`POST /api/voice/transcribe`) is a separate implementation step.

## Useful commands

```bash
docker compose logs -f speaches
docker stats agenticbot-redis agenticbot-speaches --no-stream
docker compose down
```

## RAM note

Speaches **faster-distil-whisper-large-v3** needs several GB when loaded. Increase Docker Desktop memory if preload fails. That is independent of your Ollama model directory on D:.
