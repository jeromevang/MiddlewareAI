# Module: src

## Responsibilities
- Handles core logic for rolling summaries and Mini-RAG middleware.
- Manages integration with LM Studio for embeddings and summarization.
- Provides utilities for FAISS storage, SQLite caching, and file system operations.
- Auto-starts background indexing on server startup to populate FAISS/SQLite.

## Entry Files
- `middleware.js`: Main entry point for the rolling summaries + Mini-RAG logic.
- `lmstudio_client.js`: Client for interacting with LM Studio models.
- `faiss_storage.js`: Manages embeddings using FAISS storage.
- `sqlite_cache.js`: Handles caching of embeddings and summaries in SQLite.
- `utils.js`: Contains utility functions like logging, chunk processing, and file system operations.

## Dependencies
- **LM Studio**: For generating embeddings and summaries.
  - Uses models: `text-embedding-nomic-embed-text-v1.5-embedding` (embedding, ctx 1024), `ministral-3-14b-instruct-2512`.
- **FAISS**: For efficient similarity search on embeddings.
- **SQLite**: For caching metadata related to embeddings and summaries.
- **Config**: Embedding dimension is taken from `config.json` (`storage.embedding_dimension`, default 768). `faiss_storage` pads/truncates embeddings to this dimension and now clamps to the returned embedding length on rebuild.
- **Warm-up**: On server start, summarization and main models are warmed via `/v0/chat/completions`; embedding is warmed via a tiny `/api/v0/embeddings` call (serialized with a global LM Studio lock).
- **Processing defaults**: Max chunk size capped at 400 lines; concurrency forced to 1 to reduce embedding GPU pressure during indexing.
- **Embedding caps**: Embedding input truncated to ~1024 tokens and 4000 chars max to avoid LM Studio crashes.

## Migration Notes
- Follows the migration guide in `/docs/cursor/migration-guide.md` for updates.
- Uses patterns described in `patterns.md` and modules in `modules.md`.
- Respects project-wide naming conventions and permissions.

## Context Size Configuration
- **Max Context Tokens**: 15000 (as defined in `.cursor/rules/module-context.mdc`).
- **Summarization Rule**: If context exceeds 20k tokens, I will automatically summarized to approximately 5k tokens while preserving key details and relevance.
- **Aggressive Summarization**: Enabled for large files or directories to ensure concise and actionable summaries.
