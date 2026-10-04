import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'module';

// The runner is CommonJS: load the services with the native require so the
// spies below replace the same singletons the services use.
const require = createRequire(import.meta.url);
const { redisClient } = require('../config/redis');
const { getSessionTtlSeconds, DEFAULT_SESSION_TTL_SECONDS } = require('../config/sessionTtl');
const { ConversationStore } = require('../models/conversationStore');
const modelManager = require('../models/modelManager');
const sessionService = require('../services/sessionService');
const multiLeiaService = require('../services/multiLeiaService');
const cacheService = require('../services/cacheService');

const TTL = 600;

function expiredKeys() {
  return redisClient.expire.mock.calls.map(([key]) => key);
}

beforeEach(() => {
  vi.stubEnv('SESSION_TTL_SECONDS', String(TTL));
  vi.spyOn(redisClient, 'expire').mockResolvedValue(true);
  vi.spyOn(redisClient, 'hSet').mockResolvedValue(1);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('getSessionTtlSeconds', () => {
  test('defaults to 24 hours when SESSION_TTL_SECONDS is not set', () => {
    vi.stubEnv('SESSION_TTL_SECONDS', '');

    expect(getSessionTtlSeconds()).toBe(DEFAULT_SESSION_TTL_SECONDS);
    expect(DEFAULT_SESSION_TTL_SECONDS).toBe(86400);
  });

  test('reads the value from the environment, 0 included', () => {
    expect(getSessionTtlSeconds()).toBe(TTL);

    vi.stubEnv('SESSION_TTL_SECONDS', '0');
    expect(getSessionTtlSeconds()).toBe(0);
  });

  test('falls back to the default on an invalid value', () => {
    vi.stubEnv('SESSION_TTL_SECONDS', '-5');
    expect(getSessionTtlSeconds()).toBe(DEFAULT_SESSION_TTL_SECONDS);

    vi.stubEnv('SESSION_TTL_SECONDS', 'one day');
    expect(getSessionTtlSeconds()).toBe(DEFAULT_SESSION_TTL_SECONDS);
  });
});

describe('sessionService', () => {
  test('createSession stores the session with an expiration', async () => {
    vi.spyOn(modelManager, 'getModel').mockResolvedValue({
      createSession: vi.fn().mockResolvedValue({ threadId: '', providerState: { systemInstruction: 'x' } }),
    });

    await sessionService.createSession('s1', 'x', 'model', 'alma', 'key', 'user');

    expect(redisClient.expire).toHaveBeenCalledWith('session:s1', TTL);
  });

  test('storeLeiaMeta stores the metadata with an expiration', async () => {
    await sessionService.storeLeiaMeta('s1', { leiaId: 'l1' });

    expect(redisClient.expire).toHaveBeenCalledWith('leia:meta:s1', TTL);
  });

  test('sendMessage refreshes the session, its metadata and its history', async () => {
    vi.spyOn(sessionService, 'getSession').mockResolvedValue({
      provider: 'alma',
      modelName: 'model',
      apiKeyId: 'key',
      apiKeyRequesterId: 'user',
      threadId: '',
    });
    vi.spyOn(sessionService, 'getLeiaMeta').mockResolvedValue(null);
    vi.spyOn(modelManager, 'getModel').mockResolvedValue({
      sendMessage: vi.fn().mockResolvedValue({ message: 'hi' }),
    });

    await sessionService.sendMessage('s1', 'hello');

    expect(expiredKeys()).toEqual(
      expect.arrayContaining(['session:s1', 'leia:meta:s1', 'conversation:s1'])
    );
    expect(redisClient.expire.mock.calls.every(([, ttl]) => ttl === TTL)).toBe(true);
  });

  test('SESSION_TTL_SECONDS=0 keeps the keys without expiration', async () => {
    vi.stubEnv('SESSION_TTL_SECONDS', '0');

    await sessionService.storeLeiaMeta('s1', { leiaId: 'l1' });
    await sessionService.touchSession('s1');

    expect(redisClient.expire).not.toHaveBeenCalled();
  });
});

describe('ConversationStore', () => {
  test('refreshes the history expiration on every turn', async () => {
    vi.spyOn(redisClient, 'lIndex').mockResolvedValue(null);
    vi.spyOn(redisClient, 'rPush').mockResolvedValue(1);
    vi.spyOn(redisClient, 'lTrim').mockResolvedValue('OK');
    vi.spyOn(redisClient, 'lRange').mockResolvedValue([]);
    const store = new ConversationStore({ providerName: 'alma' });

    await store.buildConversationForRequest('s1', 'system', 'hello');
    expect(redisClient.expire).toHaveBeenLastCalledWith('conversation:s1', TTL);

    redisClient.expire.mockClear();
    await store.storeAssistantResponse('s1', 'hi');
    expect(redisClient.expire).toHaveBeenCalledWith('conversation:s1', TTL);
  });
});

describe('multiLeiaService', () => {
  const runtime = {
    sessionId: 'm1',
    actors: [{ id: 'a', sessionId: 'm1:actor:a' }, { id: 'b', sessionId: 'm1:actor:b' }],
    orchestration: { routerSessionId: 'm1:orchestrator' },
  };

  test('saveRuntime stores the runtime with an expiration', async () => {
    vi.spyOn(redisClient, 'set').mockResolvedValue('OK');

    await multiLeiaService.saveRuntime(runtime);

    expect(redisClient.set).toHaveBeenCalledWith('multi-leia:m1', JSON.stringify(runtime), { EX: TTL });
  });

  test('each turn keeps the base, router and actor sessions alive', async () => {
    const touchSession = vi.spyOn(sessionService, 'touchSession').mockResolvedValue();

    await multiLeiaService.touchRuntimeSessions(runtime);

    expect(touchSession.mock.calls.map(([id]) => id).sort()).toEqual(
      ['m1', 'm1:actor:a', 'm1:actor:b', 'm1:orchestrator'].sort()
    );
  });

  test('sendMessage refreshes the sessions before handling the turn', async () => {
    const stored = {
      ...runtime,
      status: 'awaiting_user',
      graph: {},
      orchestration: { ...runtime.orchestration, maxInternalTurns: 2 },
      nextActorIndex: 0,
      sequence: 0,
      transcript: [],
      processedTurns: [{ turnId: 't1', messages: [] }],
    };
    vi.spyOn(redisClient, 'set').mockResolvedValue('OK');
    vi.spyOn(redisClient, 'get').mockImplementation(async (key) =>
      key === 'multi-leia:m1' ? JSON.stringify(stored) : null
    );
    vi.spyOn(redisClient, 'del').mockResolvedValue(1);
    const touchSession = vi.spyOn(sessionService, 'touchSession').mockResolvedValue();

    const result = await multiLeiaService.sendMessage('m1', 'hello', 't1');

    expect(result.replayed).toBe(true);
    expect(touchSession).toHaveBeenCalledWith('m1');
    expect(touchSession).toHaveBeenCalledWith('m1:orchestrator');
  });
});

describe('cacheService.filterKeysBySession', () => {
  test('selects every key of the session, including history and the MultiLEIA router', () => {
    const keys = [
      'session:m1',
      'leia:meta:m1',
      'conversation:m1',
      'session:m1:actor:a',
      'conversation:m1:actor:a',
      'session:m1:orchestrator',
      'conversation:m1:orchestrator',
      'multi-leia:m1',
      'session:m2',
      'conversation:m2',
    ];

    expect(cacheService.filterKeysBySession(keys, 'm1').sort()).toEqual(
      keys.filter((key) => !key.endsWith('m2')).sort()
    );
  });
});
