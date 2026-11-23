# Regression and integration tests

Implements [development #114](https://github.com/leia-org/development/issues/114).

```sh
npm ci
npm run test:regression
```

`npm test` runs the same finite suite; `npm run test:watch` is available for development. CI runs the regression command on Node 22 and 24 for pull requests and pushes to `main`/`develop`, without service credentials.

Session creation, Redis serialization, provider state across successive messages, BYOK user isolation, activity tool gates, deletion and failure/retry. Existing model manager, generation, MultiLEIA and opening tests also run.

External side effects are replaced at the database, HTTP adapter/fetch, Redis or model-provider boundary. No MongoDB, Redis server or paid model API is needed. These tests complement browser and deployed-stack end-to-end tests.

Live provider integration is deliberately separate: `npm run test:provider` requires provider credentials and can incur API charges. The regression command excludes `tests/providerIntegration.test.js`.

## Integration tests

```sh
npm run test:integration
```

Real authenticated routes resolve BYOK credentials over HTTP and use the production Ollama adapter with a local protocol peer. Redis persists multi-turn history across fresh provider instances, isolates users and handles provider errors/retries.

CI runs integration separately on Node 24. No production service/repository method is mocked; local HTTP peers supply deterministic contracts for external dependencies. These suites do not assert real LLM answer quality or live audio.

Set `TEST_REDIS_URL` to a dedicated Redis 7 instance, e.g. `redis://127.0.0.1:6379`. Tests delete only their UUID-scoped session/history keys. A missing URL fails the suite explicitly.
