# LM Studio Module Context

## Module Responsibilities
- Manages communication with LM Studio for local LLM inference
- Handles model loading, unloading, and state tracking
- Provides chat completions and embedding APIs
- Manages LM Studio server lifecycle (start/stop)

## Entry Files
- `model_manager.js` - Core model loading/unloading logic
- `chat.js` - Chat completions and summarization
- `embeddings.js` - Embedding generation
- `state.js` - Shared state and configuration

## Key Dependencies
- `axios` - HTTP requests to LM Studio REST API
- `child_process` - CLI execution for model loading/unloading
- `../lmstudio_manager.js` - CLI path resolution

## Important Notes

### Model Loading (Fixed 2025-12-15)
**CRITICAL**: LM Studio does NOT support `POST /api/v0/models/load` REST endpoint!
- Loading models must be done via CLI: `lms load <model-path> --yes`
- Unloading works via CLI: `lms unload <model-id>`
- Listing models works via REST: `GET /api/v0/models`
- Chat completions work via REST: `POST /api/v0/chat/completions`

### Valid LM Studio REST API Endpoints
- `GET /api/v0/models` - List models (including load state)
- `POST /api/v0/chat/completions` - Chat completions
- `POST /api/v0/embeddings` - Generate embeddings

### CLI Commands Used
- `lms load <path> --yes` - Load a model (--yes suppresses prompts)
- `lms unload <id>` - Unload a specific model
- `lms unload --all` - Unload all models
- `lms server start` - Start LM Studio server
- `lms server stop` - Stop LM Studio server
- `lms server status` - Get server status
- `lms ls` - List downloaded models

## Migration Notes
- None currently pending

