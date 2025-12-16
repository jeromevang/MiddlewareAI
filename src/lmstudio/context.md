# LM Studio Integration Module

## Overview
This module handles all interactions with LM Studio, including model loading, unloading, health checks, and inference.

## Key Files

| File | Purpose |
|------|---------|
| `model_manager.js` | Load/unload models, health checks, preset loading |
| `model_sync.js` | Sync models from `lms ls --json`, categorize by function/tier |
| `operation_queue.js` | **NEW** - p-queue based rate limiting for model operations |
| `chat.js` | Chat completions with streaming support |
| `embeddings.js` | Embedding generation for RAG |
| `state.js` | Shared state (loaded models, locks, config) |

## Model Identification System (v2.0)

### modelKey as Canonical ID
All model references now use the exact `modelKey` from LM Studio's `lms ls --json` output.

**Examples:**
- `qwen/qwen3-8b` (with publisher prefix)
- `qwen2.5-coder-1.5b-instruct` (simple key)
- `osmosis-mcp-4b@q4_k_s` (with quantization)

### No More Fuzzy Matching
The old fuzzy matching system (`normalizeModelIdForMatching`, `tokenOverlapScore`, etc.) has been removed. All lookups are now exact matches via `model_sync.js`.

## Model Categorization

### By Function
| Role | Detection | Use |
|------|-----------|-----|
| Main | `trainedForToolUse: true` | Primary chat model with tool calling |
| Summarizer | LLM without tool use | RAG and rolling summaries |
| Embedder | `type: "embedding"` | Vector embeddings for RAG |

### By Quality Tier (VRAM Budget)
| Tier | Target GPU | VRAM Budget | Max Main | Max Summarizer |
|------|------------|-------------|----------|----------------|
| Low | RTX 3060 (8GB) | 6GB | ≤3B | ≤1.5B |
| Medium | RTX 4070 (12GB) | 10GB | ≤8B | ≤3B |
| High | RTX 5080 (16GB) | 14GB | ≤14B | ≤7B |

## Role-Specific Inference Defaults

```javascript
{
  main: { temperature: 0.4, topP: 0.9, gpu: "max", contextLength: "VRAM-aware (8K min)" },
  summarizer: { temperature: 0, topP: 0.5, gpu: 0.3, maxTokens: 500, contextLength: 4096 },
```

## Production-Ready Features

### 🔄 Smart Auto-Loading
- **Startup Auto-Loading**: Automatically loads active preset on server startup
- **Background Loading**: Non-blocking, 2-second delay to avoid startup delays
- **Smart Unloading**: Only unloads models not needed for active preset
- **Configurable**: Can be disabled via `system.autoLoadModels: false`

### 🔍 Model Matching & Loading
- **Exact Matching**: Uses `modelIdMatchesExactly()` for preset loading decisions
- **Smart Pooling**: Checks what's already loaded before loading new models
- **Role-Based Settings**: Applies correct GPU offload and context limits per role
- **Error Recovery**: Graceful handling of loading failures

### 🏥 Health Monitoring
- **LM Studio Health**: `GET /lmstudio/health` endpoint with connection status
- **Model Status**: Tracks loaded models and loading states
- **Connection Validation**: Verifies LM Studio connectivity on health checks

### 📊 Resource Management
- **Memory Monitoring**: Tracks model memory usage and VRAM consumption
- **Connection Limits**: Prevents excessive concurrent model operations
- **Timeout Handling**: Configurable timeouts for all LM Studio operations
- **Retry Logic**: Automatic retry for transient failures

### 🛡️ Security & Reliability
- **Input Validation**: All model identifiers validated before operations
- **Rate Limiting**: Model loading operations are rate-limited
- **Error Boundaries**: Model loading failures don't crash the server
- **Lock Management**: Model locks prevent concurrent operations

### 🔄 Operation Queue (`operation_queue.js`)
All model operations (load/unload) are queued via p-queue to prevent LM Studio rate limiting (429 errors):

| Queue | Concurrency | Interval | Purpose |
|-------|-------------|----------|---------|
| Model Operations | 1 | 500ms | Load/unload models (serialized) |
| Read Operations | 2 | 100ms | Status checks, model listing |

**Functions:**
- `queueModelOperation(fn, options)` - Queue a model operation with priority
- `queuedLoadModel(loadFn, modelId, options)` - Queued model loading
- `queuedUnloadModel(unloadFn, modelId)` - Queued model unloading
- `getQueueStats()` - Get queue statistics (size, pending, completed)

The `openModel()` and `unloadModel()` functions in `model_manager.js` automatically use this queue.
  embedder: { gpu: "off", contextLength: "model's native" }
}
```

## Context Length Management

### VRAM-Aware Calculation
Context length for main model is calculated based on available VRAM:
- Minimum: 8192 tokens (8K)
- Formula: `availableVRAM - 2GB headroom - modelSize`
- Larger models get smaller context to fit VRAM

### Fixed Context for Other Roles
- **Summarizer**: Fixed 4096 tokens (small, fast - its job is to compress)
- **Embedder**: Model's native limit (Jina is 8K)

### Token-Based Truncation
All inputs to summarizers use token-based truncation (not character-based) to prevent context overflow errors. See `tokenizer.js:truncateToTokenLimit()`.

## Key Functions

### model_sync.js
- `syncModels()` - Fetch and categorize all models from LM Studio
- `getModelByKey(modelKey)` - Get model by exact key
- `getModelsForRoleAndTier(role, tier)` - Filter by function and quality
- `suggestModelsForPreset(tier)` - Suggest optimal models for a preset
- `getRoleDefaults(role)` - Get inference settings for a role

### model_manager.js
- `ensureModelLoaded(model, options)` - Load with role-specific settings
- `openModel(model, options)` - CLI load with GPU offload
- `ensurePresetModelsLoaded(preset)` - Load all models for a preset
- `listLoadedModels()` - Get currently loaded models

## Dependencies
- `../hardware_detector.js` - GPU detection for VRAM budgets
- `../lmstudio_manager.js` - CLI path configuration
- `../processing_state.js` - Context tracking

## Migration Notes
- Config now uses exact `modelKey` (e.g., `qwen/qwen3-4b-2507`)
- `data/models.json` presets use actual modelKeys from LM Studio
- Old preset IDs like `lmstudio-community/Qwen2.5-1.5B-Instruct-GGUF` are deprecated
