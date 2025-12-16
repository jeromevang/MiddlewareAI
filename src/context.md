# Module: src

## Responsibilities
- Handles core logic for rolling summaries and Mini-RAG middleware.
- Manages integration with LM Studio for embeddings and summarization.
- Provides utilities for FAISS storage, SQLite caching, and file system operations.
- Auto-starts background indexing on server startup to populate FAISS/SQLite.
- Manages model database with curated presets, LLM discovery, and active model tracking.
- **Production-ready with comprehensive logging, monitoring, and security features.**

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

## Custom Preset & Model Locking

### Model Lock Service (`model_lock_service.js`)

Manages lock states to prevent unwanted model changes:

| Lock Type | Behavior |
|-----------|----------|
| **Loaded Lock** | Prevents model from being unloaded during preset switches |
| **Preset Lock** | Prevents model from being replaced during auto-discovery/bootstrap |

Lock data stored in `data/model_locks.json`.

### Custom Preset

Allows users to manually select models for each role (Main, Summarizer, Embedder) with:
- VRAM usage visualization with overflow indicator
- Star ratings (1-5) based on model size
- Lock icons to protect models from automatic changes
- Role descriptions explaining what each model does

### Model Optimizer (`model_optimizer.js`)

LLM-powered optimization that:
1. Detects hardware (GPU, VRAM, RAM)
2. Loads a small model (TinyAgent-1.1B or similar) temporarily
3. Asks it to select optimal models for the hardware
4. Falls back to heuristics if no LLM available
5. Unloads the optimizer model when done

### Hugging Face Integration (`huggingface_service.js`)

Search and download models from Hugging Face:
- `GET /models/search` - Search HF for GGUF models
- `GET /models/search/:id/quants` - Get quantization options
- `POST /models/download-hf` - Download and sync with LM Studio
- Auto-syncs downloaded models to get exact `modelKey`

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/hardware` | GET | Detect GPU/RAM |
| `/hardware/check-fit` | POST | Check if models fit in VRAM |
| `/models/locks` | GET | Get all locked models |
| `/models/lock/:id` | POST/DELETE | Lock/unlock a model |
| `/models/lock/:id/toggle` | POST | Toggle lock state |
| `/presets/custom` | GET/POST | Get/save custom preset |
| `/presets/optimize` | POST | Run LLM optimization |
| `/models/search` | GET | Search Hugging Face |
| `/models/download-hf` | POST | Download from HF |

## Production-Ready Features

### 🔐 Security & Validation
- **Input Validation**: All API endpoints use Joi schemas for comprehensive input validation
- **Rate Limiting**: Express-rate-limit protects against abuse (100 req/15min general, 10 req/15min sensitive)
- **Telemetry Consent**: Debug telemetry requires explicit user consent via config
- **Secure Headers**: Rate limiting includes standard security headers

### 📊 Monitoring & Health Checks
- **Health Endpoints**:
  - `GET /health` - Basic health with system metrics
  - `GET /health/detailed` - Comprehensive component health
  - `GET /lmstudio/health` - LM Studio specific health
  - `GET /debug/system-health` - RAG component health
- **System Metrics**: CPU, memory, disk usage tracking
- **Component Monitoring**: LM Studio, SQLite, FAISS, WebSocket status
- **Performance Monitoring**: Request/response times, error rates

### 🚀 Logging & Observability
- **Winston Logger**: Structured logging with multiple transports
  - Console: Development logs with colors
  - Daily rotating files: Production logs (20MB, 14 days retention)
  - Error files: Separate error logging (30 days retention)
- **Log Levels**: error, warn, info, http, verbose, debug, silly
- **Request Logging**: Automatic HTTP request/response logging
- **Child Loggers**: Component-specific logging contexts

### 🛡️ Reliability & Resilience
- **Graceful Shutdown**: SIGINT/SIGTERM handlers with 5-second cleanup timeout
  - Closes HTTP server
  - Terminates WebSocket connections
  - Closes database connections
  - Unloads models
  - Stops active indexing
- **Error Boundaries**: Uncaught exception handling with graceful shutdown
- **Connection Management**: Proper cleanup of resources
- **Operation Queue**: p-queue based model operations with rate limiting (500ms intervals)

### ⚙️ Configuration Management
- **LM Studio Configurable**: URL, timeout, retries configurable via config.json
- **Logging Configurable**: Level, file sizes, retention periods
- **Auto-loading Configurable**: Enable/disable model auto-loading on startup
- **Validation**: Runtime config validation with helpful error messages

## Startup & Bootstrap System

### Blocking Startup Loading Screen
When the application starts, a blocking loading screen is displayed showing:
- Bootstrap progress bar with percentage
- Current phase (Connecting, Discovering, Analyzing, Building, Loading, Complete)
- Current model being analyzed
- Model count progress (X / Y models)

The loading screen is controlled by:
- `system.autoBootstrapOnStartup` setting (default: true)
- WebSocket broadcasting from `model_bootstrap.js`
- React `BootstrapLoadingScreen` component with framer-motion animations

### LM Studio Connection Retry
If LM Studio is not running at startup:
- Shows "Waiting for LM Studio..." with retry count
- Automatically retries connection every 3 seconds
- Once connected, proceeds with bootstrap

### Bootstrap Phases
1. **Connecting** (0-5%): Check LM Studio connection
2. **Discovering** (5-30%): Scan downloaded models via `lms ls`
3. **Analyzing** (30-70%): Analyze each model for capabilities
4. **Building** (70-80%): Update presets with analyzed models
5. **Loading** (80-95%): Load active preset models
6. **Complete** (100%): Ready to use

### WebSocket Bootstrap Status
The server broadcasts bootstrap status via WebSocket:
```javascript
broadcastWsMessage({ 
  type: 'bootstrap-status', 
  status: {
    phase: 'analyzing',
    progress: 45,
    message: 'Analyzing: qwen2.5-7b-instruct...',
    currentModel: 'qwen2.5-7b-instruct',
    modelsAnalyzed: 3,
    totalModels: 10
  }
});
```

## Model Locking (Preset Lock)

### Purpose
Lock models to prevent them from being removed from presets during bootstrap re-analysis.

### Lock Types
| Type | Stored In | Purpose |
|------|-----------|---------|
| `preset` | `data/model_locks.json` | Prevents removal from preset lists |
| `loaded` | (Future) | Prevents unloading from LM Studio |

### UI Integration
- **Lock buttons on model cards**: Each model in MainModelSelector shows a lock/unlock icon
- **Dedicated Models tab**: `/models` route with ModelManagementPanel for bulk lock management
- **Visual indicators**: 
  - Amber lock icon when locked
  - "Locked" badge in model details
  - Amber border on locked model cards

### API Endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/models/locks` | GET | Get all lock states |
| `/models/lock/:id` | POST | Lock a model |
| `/models/lock/:id` | DELETE | Unlock a model |
| `/models/lock/:id/toggle` | POST | Toggle lock state |

### Bootstrap Respect for Locks
When `runBootstrap()` builds presets, it:
1. Gets list of preset-locked models via `getPresetLockedModels()`
2. Never removes locked models from preset lists
3. Adds new models alongside locked ones

## System Settings

### Startup Behavior Settings
| Setting | Default | Description |
|---------|---------|-------------|
| `autoBootstrapOnStartup` | true | Run model discovery & analysis at startup |
| `autoLoadModels` | true | Auto-load active preset after bootstrap |
| `autoLoadDelayMs` | 2000 | Delay before auto-loading (ms) |

### Context Settings
| Setting | Default | Description |
|---------|---------|-------------|
| `minMainContextTokens` | 16384 | Minimum context for main models |
| `summarizerContextTokens` | 4096 | Fixed context for summarizers |
| `maxContextCap` | 131072 | Maximum context cap |

### Resource Settings
| Setting | Default | Description |
|---------|---------|-------------|
| `vramHeadroomGB` | 1.5 | Reserved VRAM for OS |
| `dynamicContextScaling` | true | Scale context with VRAM |
| `filterBelowMinContext` | true | Exclude small-context models |

### Settings UI
Access via `/settings` route or "System Settings" quick link on dashboard.

## Tool Calling System

### Overview
The middleware implements a comprehensive tool calling system that enables agentic capabilities for LLMs. Tools are automatically injected into chat completions and executed internally by the middleware.

### Tool Execution Loop
When the LLM calls a middleware tool, the middleware:
1. Detects the tool call in the LLM response
2. Executes the tool internally
3. Adds the result back to the message history
4. Re-prompts the LLM with the tool result
5. Repeats until the LLM returns a final text response

This loop runs for up to 10 iterations to prevent infinite loops.

### Available Tools (17 total)

#### Code Intelligence
| Tool | Description |
|------|-------------|
| `rag_search` | Semantic search of indexed codebase |
| `get_file_summary` | Get AI-generated file summary |
| `repo_map` | Generate code structure map with symbols |
| `grep` | Regex pattern search with context |

#### File Operations
| Tool | Description |
|------|-------------|
| `file_read` | Read file contents |
| `file_write` | Write/create files (with safety checks) |
| `file_patch` | Apply targeted text replacements |
| `file_list` | List directory contents |
| `file_search` | Search files by name or content |

#### Web Access
| Tool | Description |
|------|-------------|
| `web_search` | DuckDuckGo web search |
| `fetch_url` | Fetch and extract web page content |
| `npm_info` | Get npm package information |

#### Agent Memory
| Tool | Description |
|------|-------------|
| `memory_store` | Store key-value in session/permanent memory |
| `memory_retrieve` | Retrieve stored memory by key |
| `memory_list` | List all stored memories |

#### Automation
| Tool | Description |
|------|-------------|
| `run_command` | Execute shell commands (with security) |
| `browser_automation` | Playwright browser control |

### Client-Aware Tool Injection

| Client | Tools Injected |
|--------|----------------|
| **Cursor** | `rag_search`, `web_search`, `fetch_url`, `npm_info`, `memory_*`, `browser_automation` |
| **Continue/Other** | All 17 tools |

Detection methods:
- `x-cursor-session` header
- Presence of Cursor-specific tools (codebase_search, grep, read_file, etc.)

### Security Measures
- Path validation (must be within workspace)
- Dangerous path blocking (.git, node_modules, .env)
- Executable file blocking (.exe, .dll, .sh, .bat)
- Command pattern blocking (rm -rf /, format, fork bombs)
- Maximum output truncation