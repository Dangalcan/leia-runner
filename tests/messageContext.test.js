import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const controller = require('../controllers/leiasController');
const sessions = require('../services/sessionService');
const manager = require('../models/modelManager');
const { redisClient } = require('../config/redis');
const OpenAI = require('../models/providers/openai-responses');
const Ollama = require('../models/providers/ollama');

const note = '[Automatic context from the code editor. Not written by the student.] 1/3 tests passed.';
const opening = 'Hello, I am your tutor.';
const response = () => {
  const res = { status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};

beforeEach(() => {
  // Real session serialization between requests, without Redis or provider calls.
  const hashes = new Map();
  vi.spyOn(redisClient, 'expire').mockResolvedValue(true);
  vi.spyOn(redisClient, 'hGetAll').mockImplementation(async (key) => ({ ...hashes.get(key) }));
  vi.spyOn(redisClient, 'hSet').mockImplementation(async (key, value) => {
    hashes.set(key, { ...hashes.get(key), ...value });
  });
});
afterEach(() => vi.restoreAllMocks());

async function createLeia(provider, speaksFirst = false) {
  const res = response();
  await controller.createLeia({ body: {
    sessionId: 'session', language: 'en',
    runnerConfiguration: { provider },
    leia: { spec: { behaviour: { spec: {
      description: 'Tutor a programming exercise.',
      conversationDynamics: { leiaSpeaksFirst: { enabled: speaksFirst, config: { firstMessage: opening } } },
    } } } },
  } }, res);
  expect(res.status).toHaveBeenCalledWith(201);
}

function useOpenAI(...replies) {
  const provider = new OpenAI();
  const create = vi.fn();
  replies.forEach((reply) => create.mockResolvedValueOnce(reply));
  vi.spyOn(provider, 'getClient').mockReturnValue({ responses: { create } });
  vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
  return create;
}

describe('hidden per-turn context', () => {
  test('goes to the model as a developer item right before the participant message and is acknowledged', async () => {
    const create = useOpenAI({ id: 'resp-1', output_text: 'I see two tests failing.' });
    await createLeia('openai-responses');

    const result = await sessions.sendMessage('session', 'hi', { context: note });

    expect(create.mock.calls[0][0].input).toEqual([
      { role: 'user', content: JSON.stringify({ context: note }) },
      { role: 'user', content: 'hi' },
    ]);
    expect(result).toEqual({ message: 'I see two tests failing.', contextApplied: true });
  });

  test('is acknowledged as well when the model answers with tool calls', async () => {
    const create = useOpenAI({
      id: 'resp-tool',
      output: [{ type: 'function_call', call_id: 'call-read', name: 'codeEditor_read', arguments: '{}' }],
    });
    await createLeia('openai-responses');
    await sessions.storeLeiaMeta('session', { toolFunctionsEnabled: 'true' });

    const result = await sessions.sendMessage('session', 'hi', {
      context: note,
      tools: [{ name: 'codeEditor_read' }],
    });

    expect(create.mock.calls[0][0].input[0]).toEqual({ role: 'user', content: JSON.stringify({ context: note }) });
    expect(result.contextApplied).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
  });

  test('sits between the pending opening and the participant message', async () => {
    const create = useOpenAI(
      { id: 'resp-opening', output_text: opening },
      { id: 'resp-next', output_text: 'Sure.' }
    );
    await createLeia('openai-responses', true);
    await sessions.sendMessage('session', 'Start the conversation now.', { opening: true });

    await sessions.sendMessage('session', 'hi', { context: note });

    expect(create.mock.calls[1][0].input).toEqual([
      { role: 'assistant', content: opening },
      { role: 'user', content: JSON.stringify({ context: note }) },
      { role: 'user', content: 'hi' },
    ]);
  });

  test('without a context the request and the response keep their previous shape', async () => {
    const create = useOpenAI({ id: 'resp-1', output_text: 'Hello.' });
    await createLeia('openai-responses');

    const result = await sessions.sendMessage('session', 'hi');

    expect(create.mock.calls[0][0].input).toEqual([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ message: 'Hello.' });
  });

  test('is ignored and not acknowledged on the startup request', async () => {
    const create = useOpenAI({ id: 'resp-opening', output_text: opening });
    await createLeia('openai-responses', true);

    const result = await sessions.sendMessage('session', 'Start the conversation now.', {
      opening: true,
      context: note,
    });

    expect(create.mock.calls[0][0].input).toEqual([{ role: 'developer', content: 'Start the conversation now.' }]);
    expect(result).not.toHaveProperty('contextApplied');
  });

  test('is ignored and not acknowledged on a tool continuation', async () => {
    const create = useOpenAI(
      { id: 'resp-tool', output: [{ type: 'function_call', call_id: 'call-run', name: 'run', arguments: '{}' }] },
      { id: 'resp-final', output_text: 'Done.' }
    );
    await createLeia('openai-responses');
    await sessions.storeLeiaMeta('session', { toolFunctionsEnabled: 'true' });
    await sessions.sendMessage('session', 'run them', { tools: [{ name: 'run' }] });

    const result = await sessions.sendMessage('session', null, {
      toolResults: [{ callId: 'call-run', output: 'ok' }],
      context: note,
    });

    expect(create.mock.calls[1][0].input).toEqual([
      { type: 'function_call_output', call_id: 'call-run', output: 'ok' },
    ]);
    expect(result).not.toHaveProperty('contextApplied');
  });

  test('providers without support ignore it and do not acknowledge', async () => {
    const provider = new Ollama();
    const lists = new Map();
    vi.spyOn(redisClient, 'lIndex').mockImplementation(async (key, index) => lists.get(key)?.[index] ?? null);
    vi.spyOn(redisClient, 'rPush').mockImplementation(async (key, value) => {
      lists.set(key, [...(lists.get(key) || []), value]);
    });
    vi.spyOn(redisClient, 'lTrim').mockImplementation(async (key, start) => {
      lists.set(key, (lists.get(key) || []).slice(start));
    });
    vi.spyOn(redisClient, 'lRange').mockImplementation(async (key) => lists.get(key) || []);
    const completion = vi.spyOn(provider, 'createChatCompletion')
      .mockResolvedValueOnce({ message: { content: 'Hello.' } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia('ollama');

    const result = await sessions.sendMessage('session', 'hi', { context: note });

    // No acknowledgement: the caller keeps the context pending.
    expect(result).toEqual({ message: 'Hello.' });
    expect(JSON.stringify(completion.mock.calls)).not.toContain('Automatic context');
  });
});

describe('POST /leias/:sessionId/messages — context validation', () => {
  async function post(body) {
    const res = response();
    await controller.sendLeiaMessage({ params: { sessionId: 'session' }, body }, res);
    return res;
  }

  test.each([
    ['not a string', 42],
    ['empty', '   '],
    ['too long', 'x'.repeat(4001)],
  ])('rejects a context that is %s', async (_label, context) => {
    const spy = vi.spyOn(sessions, 'sendMessage');

    const res = await post({ message: 'hi', context });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(spy).not.toHaveBeenCalled();
  });

  test('forwards a valid context to the session service', async () => {
    vi.spyOn(sessions, 'getSession').mockResolvedValue({ sessionId: 'session' });
    const spy = vi.spyOn(sessions, 'sendMessage').mockResolvedValue({ message: 'ok', contextApplied: true });

    const res = await post({ message: 'hi', context: note });

    expect(spy).toHaveBeenCalledWith('session', 'hi', expect.objectContaining({ context: note }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({ message: 'ok', contextApplied: true });
  });
});
