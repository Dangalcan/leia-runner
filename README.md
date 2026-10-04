# LEIA Customer API

API for interacting with LEIA instances.

## Requirements

- Node.js 20+
- npm
- Redis

## Usage

### Start the server

```bash
npm start
```

### Start the server in development mode

```bash
npm run dev
```

### Tests

```bash
npm run test:unit      # unit tests, no network or Redis needed
npm run test:provider  # OpenAI and Gemini integration (OPENAI_API_KEY, GEMINI_API_KEY)
npm run test:alma      # ALMA unit and integration tests (ALMA_API_KEY)
```

## Model providers

Each file in `models/providers/` is a provider module. `GET /api/v1/models`
lists them, together with the API key provider each one accepts and the model
it serves. The designer and the workbench build their provider and model
choices from that response.

API keys are not configured in the runner. A LEIA session carries an
`apiKeyId`, and the runner resolves the key (and, for some providers, its base
URL) from leia-auth (`VITE_AUTH_SERVICE_BACKEND`, `INTERN_TOKEN`).

| Module | API key provider | Notes |
|---|---|---|
| `openai-responses` | `openai` | Only provider with tool calling (widgets) |
| `gemini-3.1-flash-lite-preview` | `gemini` | |
| `ollama` | `ollama` | Local models; history kept in Redis |
| `alma` | `alma` | ALMA (alma.us.es); history kept in Redis |

### ALMA

[ALMA](https://alma.us.es) serves each model behind its own OpenAI-compatible
base URL, `https://alma.us.es/api/models/{slug}/v1`, and authenticates with the
`apikey` header. To use it, create a LEIA API key with provider `alma`, the ALMA
key and that base URL; the key's base URL overrides `ALMA_BASE_URL`.

| Variable | Default | Purpose |
|---|---|---|
| `ALMA_BASE_URL` | `https://alma.us.es/api/models/llama-3.1-8b-instruct/v1` | Base URL when the API key has none |
| `ALMA_MODEL` | `meta-llama/Llama-3.1-8B-Instruct` | Model id sent in the request body (the Hugging Face repo id, not the slug) |
| `ALMA_MAX_TOKENS` | `1024` | Max tokens per reply |
| `ALMA_EVALUATION_MAX_TOKENS` | `2048` | Max tokens per solution evaluation |
| `ALMA_TEMPERATURE` | `0.7` | Sampling temperature |
| `ALMA_HISTORY_MAX_MESSAGES` | `CONVERSATION_HISTORY_MAX_MESSAGES` | Messages kept in the history |

`ALMA_MODEL` must be the model behind the base URL: the ALMA gateway routes by
the slug in the URL and vLLM rejects any other model id.

## Session expiration

Sessions, their LEIA metadata, their conversation history and MultiLEIA
runtimes expire from Redis `SESSION_TTL_SECONDS` after their last activity
(default `86400`, 24 h). Every message restarts the countdown. `0` disables
expiration.

## API

The API provides the following endpoints:

### Create a LEIA instance

```
POST /api/v1/leias
```

**Headers:**

```
Authorization: Bearer YOUR_RUNNER_KEY
```

**Body:**

```json
{
  "sessionId": "unique-session-id",
  "leia": {
    "spec": {
      "persona": { ... },
      "behaviour": { ... },
      "problem": { ... }
    }
  },
  "runnerConfiguration": {
    "provider": "alma",
    "modelName": "meta-llama/Llama-3.1-8B-Instruct",
    "apiKeyId": "leia-auth-api-key-id",
    "apiKeyRequesterId": "leia-auth-user-id"
  }
}
```

**Responses:**

- `201 Created`: LEIA created successfully
- `400 Bad Request`: Required parameters missing
- `401 Unauthorized`: Invalid authentication token
- `409 Conflict`: Session with the same ID already exists
- `500 Internal Server Error`: Internal server error

### Send message to a LEIA instance

```
POST /api/v1/leias/:sessionId/messages
```

**Headers:**

```
Authorization: Bearer YOUR_RUNNER_KEY
```

**Body:**

```json
{
  "message": "Your message for LEIA"
}
```

**Responses:**

- `200 OK`: Message processed successfully
- `400 Bad Request`: Required parameters missing
- `401 Unauthorized`: Invalid authentication token
- `404 Not Found`: Session with the provided ID not found
- `500 Internal Server Error`: Internal server error

### List available models

```
GET /api/v1/models
```

**Headers:**

```
Authorization: Bearer YOUR_RUNNER_KEY
```

**Response:**

```json
{
  "models": ["alma", "gemini-3.1-flash-lite-preview", "ollama", "openai-responses"],
  "default": "openai-responses",
  "apiKeyProviders": {
    "alma": ["meta-llama/Llama-3.1-8B-Instruct"],
    "gemini": ["gemini-3.1-flash-lite-preview"],
    "ollama": ["gemma3:4b"],
    "openai": ["gpt-5.4-mini"]
  },
  "providerProviderModuleMap": {
    "alma": "alma",
    "gemini": "gemini-3.1-flash-lite-preview",
    "ollama": "ollama",
    "openai": "openai-responses"
  }
}
```

**Responses:**

- `200 OK`: List of models retrieved successfully
- `401 Unauthorized`: Invalid authentication token
- `500 Internal Server Error`: Internal server error

## Documentation

API documentation is available at:

```
http://localhost:5000/docs
```
