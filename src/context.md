# Module: src

## Responsibilities
- Handles core logic for rolling summaries and Mini-RAG middleware.
- Manages integration with LM Studio for embeddings and summarization.
- Provides utilities for FAISS storage, SQLite caching, and file system operations.
- Auto-starts background indexing on server startup to populate FAISS/SQLite.
- Manages model database with curated presets, LLM discovery, and active model tracking.

## Entry Files
- `middleware.js`: Main entry point for the rolling summaries + Mini-RAG logic.
- `lmstudio_client.js`: Client for interacting with LM Studio models.
- `faiss_storage.js`: Manages embeddings using FAISS storage.
- `sqlite_cache.js`: Handles caching of embeddings and summaries in SQLite.
- `utils.js`: Contains utility functions like logging, chunk processing, and file system operations.
- `model_db_service.js`: Manages model database with curated presets, LLM discovery, dynamic re-ranking, and startup validation.

## Recent Changes
- Added startup model validation that checks preset models against LM Studio downloads
- Added `lms` CLI integration for model downloads (`lms get <model>`)
- Models now have `available` flag synced at startup
- Frontend shows availability badges and download buttons for missing models
- Added model bootstrap system using TinyAgent-1.1B to analyze and categorize models
- Bootstrap runs at startup and populates quality presets automatically
- UI shows loading overlay during bootstrap with progress indicator
- **Dual Summarizer Architecture**: Split single summarizer into:
  - RAG Summarizer: Optimized for code chunk summarization during indexing
  - Rolling Summarizer: Optimized for conversation memory compression
- Config now has `ragSummarization` and `rollingSummarization` sections
- UI shows 4 model cards: Embedding, RAG Summarizer, Rolling Summarizer, Main Model
- **Model ID Matching**: Added intelligent matching between preset IDs and actual LM Studio identifiers
  - `findLMStudioModelId()` matches preset IDs like `lmstudio-community/Qwen2.5-3B-Instruct-GGUF` to actual downloaded models like `qwen2.5-3b-instruct`
  - Uses normalized matching, substring matching, and token-based fuzzy matching
- **Smart Model Unloading**: 
  - When switching presets: unloads unused models, keeps shared ones, loads new ones
  - When manually switching main model: unloads previous, loads new, keeps summarizers
- **Quantization Selection for Downloads**:
  - Added `GET /models/quant-options` endpoint returning available quantizations (Q4_K_M, Q5_K_M, Q8_0, Q3_K_M, Q2_K)
  - Download API now accepts `quantization` parameter: `POST /models/download/:id` with body `{ quantization: 'q4_k_m' }`
  - CLI command now uses `lms get model-name@quant -y` format
  - UI shows "Download Quality" dropdown in Model Configuration section
  - Default quantization is Q4_K_M (balanced size/quality)
  - **Auto-load after download**: Models are automatically loaded into LM Studio after download completes
- **Codebase Refactoring**:
  - Created `routes/` folder with modular route files (status, config, lmstudio, models, sessions, rag)
  - Created `models/` folder with split modules (database, presets, matcher, downloader)
  - Created `middleware/` folder with error-handler.js and logging.js
  - Created `config/`, `storage/`, `utils/` folders with index files
  - Frontend: Created `model-config/` components (PresetSelector, ModelCards, MainModelList)
  - Frontend: Created `lib/api/` with split API modules (client, models, lmstudio)

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

## Context-Aware Summarization

The middleware now implements dual-mode context-aware summarization to prevent context overflow:

### Two Modes

| Mode | Trigger | Action |
|------|---------|--------|
| **Engine ON** | `turns > keep_recent_turns` | Summarize oldest turns, keep X recent |
| **Engine OFF** | `tokens > maxContext` | Summarize minimum to fit max (maximize context) |

### Key Components

- **`src/tokenizer.js`**: Accurate token counting using @xenova/transformers AutoTokenizer
- **`src/processing_state.js`**: Tracks main model max context (`getMainModelMaxContext()`, `setMainModelMaxContext()`)
- **`src/lmstudio/model_manager.js`**: Updates max context when main model is loaded
- **`src/server.js`**: 
  - `handleTurnBasedSummary()` - Mode 1: Proactive summarization after X turns
  - `handleContextBasedSummary()` - Mode 2: Reactive summarization when context overflows
  - `ensureContextFitsModel()` - Entry point that selects the appropriate mode

### Algorithm (Context-Based Mode)

1. Count tokens for each message using the tokenizer
2. If total <= max: no action needed
3. Work backwards from newest messages, keeping as many as fit within budget
4. Summarize all older messages
5. Return: `[system, summary, recent_messages]`

### Configuration

```json
{
  "engines": {
    "summary": {
      "enabled": false  // false = context-based, true = turn-based
    }
  },
  "processing": {
    "summary_keep_recent_turns": 3  // For turn-based mode
  }
}
```

### Use Cases

- **Engine ON (turn-based)**: Use with larger models that have smaller context. Proactively summarizes to keep inference fast.
- **Engine OFF (context-based)**: Use with smaller models that have larger context. Maximizes context until overflow.