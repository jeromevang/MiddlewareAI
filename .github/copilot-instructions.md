# Copilot Instructions

## Orientation
- Express orchestration lives in [src/server.js](../src/server.js); it exposes /status, /metrics, /logs, /history, /config, /search, /query, /reindex, /reset, /lmstudio/restart, plus OpenAI-compatible chat endpoints bridging Cursor ⇄ middleware ⇄ LM Studio.
- Startup flow calls [initializeLMStudio()](../src/lmstudio_manager.js) and then runs the indexer via [runIndexer()](../src/middleware.js) in the background; assume reindexing might still be running before serving traffic.
- LM Studio HTTP helpers (embedding, summarization, completions, warmers) are centralized in [src/lmstudio_client.js](../src/lmstudio_client.js); never issue raw axios/fetch calls directly to LM Studio.
- Local embeddings default to the CPU Xenova pipeline in [src/embedder_local.js](../src/embedder_local.js) whenever `models.embedding.engine === "local"` in [config.json](../config.json).

## Runtime & Workflows
- Start the server with `node src/server.js`; ensure LM Studio is running (config `lmstudio.auto_start` is false by default) or enable auto-start in config before launching.
- Manually rebuild the RAG assets with `node src/middleware.js --model-version <identifier>`; the same entry point powers POST /reindex and POST /reset.
- Inspect health without re-running heavy flows by calling /status or /metrics; use /logs and /history to grab the in-memory ring buffers when debugging.
- Update configuration via PATCH /config or by editing [config.json](../config.json) and restarting; the server redacts `server.api_key` automatically in responses.

## Data, Models & Storage
- Content chunks, embeddings, and summaries persist through [SQLiteCacheManager](../src/sqlite_cache.js) in [data/](../data) and [FAISSIndexManager](../src/faiss_storage.js) in [vector_db/](../vector_db); keep those paths consistent with `storage.*` in config.
- Chunk IDs are SHA256 hashes of `<filePath>:<startLine>` via `generateChunkHash()` in [src/middleware.js](../src/middleware.js); changing that scheme will orphan FAISS/SQLite rows.
- Rolling conversation summaries live in the `rolling_summaries` table (same SQLite DB) and drive long-term memory in `/query` and chat completions.
- Respect the configured embedding dimension (default 384) when introducing new model outputs; `FAISSIndexManager.normalizeEmbeddingVector()` enforces trim/pad before writes.

## Processing Patterns
- Chunking is capped at 400 lines (`MAX_CHUNK_SIZE`) and single-worker concurrency (`CONCURRENCY_LIMIT = 1`) to avoid GPU/CPU pressure; follow that pattern for new processors.
- Always call `sqliteCacheManager.initialize()` + `faissIndexManager.initialize()` before touching their APIs and gate FAISS mutations through `withLock()` as done in [src/faiss_storage.js](../src/faiss_storage.js).
- RAG searches call `embedText()` → `faissIndexManager.searchSimilar()` → SQLite retrieval/validation; emulate `ragSearch()` from [src/server.js](../src/server.js) instead of skipping cache validation.
- Context assembly happens in `buildContextWithBudget()` with a default $\approx 0.7$ of 40k tokens; reuse it (or its pattern) so rolling summaries and RAG snippets share the same trimming logic.

## Existing Agent Rules
- Cursor-specific expectations live under [.cursor/rules](../.cursor/rules) (notably `important.mdc`, `project-awareness.mdc`, and `context-control.mdc`): work visibly, preload docs when they exist, and minimize file reads.
- When architecting new flows, add request/metrics logging in [src/server.js](../src/server.js) so /logs and /history stay informative and the DEBUG_LOG_ENDPOINT ingests key lifecycle events.
- Prefer extending existing modules (server.js, middleware.js, sqlite_cache.js, faiss_storage.js, lmstudio_client.js) instead of adding ad-hoc helpers; each already centralizes error handling and retry/backoff behavior.
- Keep data directories (`data/`, `vector_db/`) and network dependencies (`lmstudio.url`, local embedding models) configurable via [config.json](../config.json) so deployments stay environment-agnostic.
