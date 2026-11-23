import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import express from 'express';

const require = createRequire(import.meta.url);
let redisClient, manager, service, http, peers;
const sessionIds = [];
const modelRequests = [], keyRequests = [];
let failProvider = false;
const listen = async (app) => {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
};
const request = (path, body, authorized = true) => fetch(`${http.url}/api/v1${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer integration-runner' } : {}) }, body: JSON.stringify(body),
});
const payload = (sessionId, owner = 'owner-a') => ({ sessionId, language: 'es',
  runnerConfiguration: { provider: 'ollama', modelName: 'fixture-model', apiKeyId: `key-${owner}`, apiKeyRequesterId: owner },
  leia: { id: 'fixture-leia', spec: { behaviour: { spec: { description: 'Stay in character' } }, problem: { spec: { solution: 'Private solution' } } } },
});
const sessionId = () => { const id = `integration-${randomUUID()}`; sessionIds.push(id); return id; };

beforeAll(async () => {
  if (!process.env.TEST_REDIS_URL) throw new Error('TEST_REDIS_URL is required for integration tests');
  vi.stubEnv('REDIS_URL', process.env.TEST_REDIS_URL); vi.stubEnv('RUNNER_KEY', 'integration-runner');
  vi.stubEnv('INTERN_TOKEN', 'integration-intern'); vi.stubEnv('OLLAMA_MODEL', 'fixture-model');
  ({ redisClient } = require('../../config/redis'));
  await redisClient.connect();
  const peer = express(); peer.use(express.json());
  peer.post('/api/v1/apikeys/get-value', (req, res) => {
    keyRequests.push({ ...req.body, internToken: req.headers['x-intern-token'] });
    if (req.headers['x-intern-token'] !== 'integration-intern') return res.sendStatus(401);
    res.json({ keyValue: 'synthetic-local-key', baseUrl: peers.url });
  });
  peer.post('/api/chat', (req, res) => {
    modelRequests.push(req.body);
    if (failProvider) return res.status(503).json({ error: 'Provider unavailable' });
    res.json({ message: { role: 'assistant', content: `Answer: ${req.body.messages.at(-1).content}` }, done: true });
  });
  peers = await listen(peer); vi.stubEnv('VITE_AUTH_SERVICE_BACKEND', peers.url);
  manager = require('../../models/modelManager'); await manager.initialize();
  service = require('../../services/sessionService');
  const app = express(); app.use(express.json()); app.use('/api/v1', require('../../routes/leiasRoutes'));
  http = await listen(app);
});
afterAll(async () => {
  await http?.close(); await peers?.close();
  if (redisClient?.isOpen) {
    // Delete only this run's UUID-scoped keys, never FLUSHDB.
    for (const id of sessionIds) await redisClient.del([`session:${id}`, `leia:meta:${id}`, `conversation:${id}`]);
    await redisClient.quit();
  }
  manager?.instancePromiseCache.clear(); vi.unstubAllEnvs();
});

test('real routes, credential HTTP resolution, Ollama adapter and Redis preserve a complete two-turn conversation', async () => {
  const id = sessionId();
  expect((await request('/leias', payload(id), false)).status).toBe(401);
  expect((await request('/leias', payload(id))).status).toBe(201);
  expect((await request('/leias', payload(id))).status).toBe(409);
  expect((await redisClient.hGetAll(`session:${id}`)).apiKeyRequesterId).toBe('owner-a');
  const first = await request(`/leias/${id}/messages`, { message: 'First question' });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ message: 'Answer: First question' });
  // Force a fresh provider instance; the next turn must recover context from Redis.
  manager.instancePromiseCache.clear();
  const second = await request(`/leias/${id}/messages`, { message: 'Follow-up question' });
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({ message: 'Answer: Follow-up question' });
  expect(modelRequests.at(-1).messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
  expect(modelRequests.at(-1).messages[0].content).toContain('Stay in character');
  expect(modelRequests.at(-1).messages[0].content).toContain('"es"');
  expect(modelRequests.at(-1).messages[2].content).toBe('Answer: First question');
  expect(keyRequests.at(-1)).toMatchObject({ provider: 'ollama', apiKeyId: 'key-owner-a', apiKeyRequesterId: 'owner-a', internToken: 'integration-intern' });
  expect(await redisClient.lLen(`conversation:${id}`)).toBe(5);
});

test('provider errors do not fabricate an assistant response and another session never receives private history', async () => {
  const id = sessionId();
  expect((await request('/leias', payload(id, 'owner-b'))).status).toBe(201);
  failProvider = true;
  try {
    const failed = await request(`/leias/${id}/messages`, { message: 'Private question B' });
    expect(failed.status).toBe(500);
    expect((await redisClient.lRange(`conversation:${id}`, 0, -1)).map(JSON.parse).some((message) => message.role === 'assistant')).toBe(false);
  } finally { failProvider = false; }
  const retry = await request(`/leias/${id}/messages`, { message: 'Retry B' });
  expect(retry.status).toBe(200);
  expect(JSON.stringify(modelRequests.at(-1))).not.toContain('First question');
  expect((await service.getSession(id)).apiKeyId).toBe('key-owner-b');
  await service.deleteSession(id);
  expect((await request(`/leias/${id}/messages`, { message: 'After deletion' })).status).toBe(404);
  expect(await redisClient.exists(`leia:meta:${id}`)).toBe(0);
});
