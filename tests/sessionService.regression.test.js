import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sessionService = require('../services/sessionService');
const modelManager = require('../models/modelManager');
const { redisClient } = require('../config/redis');
const config = { provider: 'openai-responses', modelName: 'fixture-model', apiKeyId: 'key-a', apiKeyRequesterId: 'owner-a' };
let hashes, model;

beforeEach(() => {
  // An in-memory Redis boundary exercises serialization and persistence together.
  hashes = new Map();
  vi.spyOn(redisClient, 'hSet').mockImplementation(async (key, value) => {
    hashes.set(key, { ...hashes.get(key), ...value });
    return 1;
  });
  vi.spyOn(redisClient, 'hGetAll').mockImplementation(async (key) => ({ ...hashes.get(key) }));
  vi.spyOn(redisClient, 'del').mockImplementation(async (keys) => {
    let deleted = 0;
    for (const key of keys) deleted += hashes.delete(key) ? 1 : 0;
    return deleted;
  });
  model = {
    createSession: vi.fn().mockResolvedValue({ threadId: '', providerState: { systemInstruction: 'Stay in character' } }),
    sendMessage: vi.fn().mockResolvedValue({ message: 'Hello' }),
  };
  vi.spyOn(modelManager, 'getModel').mockResolvedValue(model);
});
afterEach(() => vi.restoreAllMocks());
const create = (sessionId = 'session-a', overrides = {}) => {
  const c = { ...config, ...overrides };
  return sessionService.createSession(sessionId, 'Stay in character', c.modelName, c.provider, c.apiKeyId, c.apiKeyRequesterId);
};

describe('Runner session lifecycle regressions', () => {
  test('persists provider state across messages without losing credentials or exposing internal state', async () => {
    await create();
    model.sendMessage.mockResolvedValueOnce({ message: 'First answer', sessionData: { threadId: 'response-1', providerState: { cursor: 1 } } });
    expect(await sessionService.sendMessage('session-a', 'First question')).toEqual({ message: 'First answer' });
    await sessionService.sendMessage('session-a', 'Second question');
    expect(model.sendMessage.mock.calls[1][0].sessionData).toMatchObject({ ...config, threadId: 'response-1', providerState: { cursor: 1 } });
    expect(modelManager.getModel).toHaveBeenLastCalledWith('openai-responses', 'key-a', 'owner-a', 'openai-responses:fixture-model:key-a');
    expect(hashes.get('session:session-a').providerState).toBe('{"cursor":1}');
  });

  test('keeps session/provider state isolated between two users', async () => {
    await create();
    await create('session-b', { apiKeyId: 'key-b', apiKeyRequesterId: 'owner-b' });
    await sessionService.updateSession('session-a', { providerState: { responseId: 'private-a' } });
    await sessionService.sendMessage('session-b', 'Question');
    expect(modelManager.getModel).toHaveBeenLastCalledWith(config.provider, 'key-b', 'owner-b', `${config.provider}:${config.modelName}:key-b`);
    expect(model.sendMessage.mock.calls[0][0].sessionData.providerState).toEqual({ systemInstruction: 'Stay in character' });
    expect((await sessionService.getSession('session-a')).providerState).toEqual({ responseId: 'private-a' });
  });

  test.each([null, false, 'false'])('does not forward tool calls when the activity gate is %s', async (enabled) => {
    await create();
    await sessionService.storeLeiaMeta('session-a', { toolFunctionsEnabled: enabled });
    await sessionService.sendMessage('session-a', 'Question', { tools: [{ name: 'private-tool' }], toolResults: [{ output: 'secret' }] });
    expect(model.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ allowTools: false, tools: undefined, toolResults: undefined }));
  });

  test.each([{ metadata: true, internalTools: false }, { metadata: false, internalTools: true }])('allows explicit activity or internal tools: %j', async ({ metadata, internalTools }) => {
    await create();
    await sessionService.storeLeiaMeta('session-a', { toolFunctionsEnabled: metadata });
    const options = { internalTools, opening: true, tools: [{ name: 'approved-tool' }], toolResults: [{ output: 'ok' }] };
    await sessionService.sendMessage('session-a', 'Question', options);
    expect(model.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ ...options, allowTools: true }));
  });

  test('a missing session never resolves credentials or calls a provider', async () => {
    expect(await sessionService.sendMessage('missing', 'Question')).toBeNull();
    expect(await sessionService.updateSession('missing', { threadId: 'unexpected' })).toBeNull();
    expect(modelManager.getModel).not.toHaveBeenCalled();
    expect(redisClient.hSet).not.toHaveBeenCalled();
  });

  test('deletes both the session and its metadata without touching another user', async () => {
    await create();
    await create('session-b');
    await sessionService.storeLeiaMeta('session-a', { solution: 'private solution' });
    await sessionService.deleteSession('session-a');
    expect(await sessionService.getSession('session-a')).toBeNull();
    expect(await sessionService.getLeiaMeta('session-a')).toBeNull();
    expect(await sessionService.getSession('session-b')).not.toBeNull();
  });

  test('a provider failure preserves the last successful cursor for retry', async () => {
    await create();
    await sessionService.updateSession('session-a', { threadId: 'last-success' });
    const saved = structuredClone(hashes.get('session:session-a'));
    model.sendMessage.mockRejectedValueOnce(new Error('Provider unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(sessionService.sendMessage('session-a', 'Question')).rejects.toThrow('Provider unavailable');
    expect(hashes.get('session:session-a')).toEqual(saved);
    await sessionService.sendMessage('session-a', 'Retry');
    expect(model.sendMessage.mock.calls[1][0].sessionData.threadId).toBe('last-success');
  });
});
