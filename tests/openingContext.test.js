import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const controller = require('../controllers/leiasController');
const sessions = require('../services/sessionService');
const manager = require('../models/modelManager');
const { redisClient } = require('../config/redis');
const OpenAI = require('../models/providers/openai-responses');
const Gemini = require('../models/providers/gemini-3.1-flash-lite-preview');
const Ollama = require('../models/providers/ollama');

const opening = "Hi, I'll be conducting the interview with my AirPods.";
const followUp = 'how u will be conducting the interview?';
const startup = `Start the conversation now. This is an internal startup instruction, not a student message. Your first message must follow these instructor instructions: ${opening}`;
const response = () => {
  const res = { status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};

beforeEach(() => {
  // Exercise the real session serialization between requests without Redis or
  // provider network calls. The next turn must reload the saved provider state.
  const hashes = new Map();
  vi.spyOn(redisClient, 'hGetAll').mockImplementation(async (key) => ({ ...hashes.get(key) }));
  vi.spyOn(redisClient, 'hSet').mockImplementation(async (key, value) => {
    hashes.set(key, { ...hashes.get(key), ...value });
  });
});
afterEach(() => vi.restoreAllMocks());

async function createLeia(provider, enabled = true) {
  const res = response();
  await controller.createLeia({ body: {
    sessionId: 'session', language: 'en',
    runnerConfiguration: { provider },
    leia: { spec: { behaviour: { spec: {
      description: 'Conduct an interview.',
      conversationDynamics: { leiaSpeaksFirst: { enabled, config: { firstMessage: opening } } },
    } } } },
  } }, res);
  expect(res.status).toHaveBeenCalledWith(201);
}

describe('LEIA speaks first provider context', () => {
  test('disabled opening starts with the participant and continues without any opening context', async () => {
    const provider = new OpenAI();
    const create = vi.fn()
      .mockResolvedValueOnce({ id: 'resp-first', output_text: 'Understood.' })
      .mockResolvedValueOnce({ id: 'resp-next', output_text: 'ORION.' });
    vi.spyOn(provider, 'getClient').mockReturnValue({ responses: { create } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia('openai-responses', false);
    await sessions.sendMessage('session', 'My project is called ORION.');
    const first = create.mock.calls[0][0];
    expect(first.input).toEqual([{ role: 'user', content: 'My project is called ORION.' }]);
    expect(first.store).toBe(true);
    expect(first).not.toHaveProperty('previous_response_id');
    await sessions.sendMessage('session', 'What is my project called?');
    const next = create.mock.calls[1][0];
    expect(next.input).toEqual([{ role: 'user', content: 'What is my project called?' }]);
    expect(next.previous_response_id).toBe('resp-first');
    expect(next.instructions).toBe(first.instructions);
    expect(next.instructions).not.toContain('Dialogue grounding requirement');
    const session = await sessions.getSession('session');
    expect(session.providerState.firstAssistantMessage).toBeUndefined();
    expect(session.providerState.openingPending).toBe(false);
  });

  test('disabled opening still supports tools on the first participant turn', async () => {
    const provider = new OpenAI();
    const create = vi.fn()
      .mockResolvedValueOnce({ id: 'resp-tool', output: [{ type: 'function_call', call_id: 'call-read', name: 'read', arguments: '{}' }] })
      .mockResolvedValueOnce({ id: 'resp-final', output_text: 'Done.' });
    vi.spyOn(provider, 'getClient').mockReturnValue({ responses: { create } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia('openai-responses', false);
    await sessions.storeLeiaMeta('session', { toolFunctionsEnabled: 'true' });
    await sessions.sendMessage('session', 'Read the editor', { tools: [{ name: 'read' }] });
    await sessions.sendMessage('session', null, { toolResults: [{ callId: 'call-read', output: 'editor content' }] });
    expect(create.mock.calls[0][0]).toMatchObject({
      input: [{ role: 'user', content: 'Read the editor' }], tools: [{ type: 'function', name: 'read' }], store: true,
    });
    expect(create.mock.calls[1][0]).toMatchObject({
      previous_response_id: 'resp-tool', input: [{ type: 'function_call_output', call_id: 'call-read', output: 'editor content' }],
    });
    expect((await sessions.getSession('session')).providerState.firstAssistantMessage).toBeUndefined();
  });

  test('OpenAI sends the generated opening as assistant history, then chains subsequent responses', async () => {
    const provider = new OpenAI();
    const create = vi.fn()
      .mockResolvedValueOnce({ id: 'resp-opening', output_text: opening })
      .mockResolvedValueOnce({ id: 'resp-followup', output_text: 'Using my AirPods.' })
      .mockResolvedValueOnce({ id: 'resp-next', output_text: 'Yes.' });
    vi.spyOn(provider, 'getClient').mockReturnValue({ responses: { create } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia('openai-responses');
    const res = response();
    await controller.sendLeiaMessage({ params: { sessionId: 'session' }, body: { message: startup, opening: true } }, res);
    expect(res.send).toHaveBeenCalledWith({ message: opening });
    expect(create.mock.calls[0][0]).toMatchObject({ input: [{ role: 'developer', content: startup }], store: false });
    await sessions.sendMessage('session', followUp);
    const payload = create.mock.calls[1][0];
    expect(payload).not.toHaveProperty('previous_response_id');
    expect(payload).not.toHaveProperty('conversation');
    expect(payload.instructions).toContain(JSON.stringify(opening));
    expect(payload.instructions).toContain('not restarting the conversation');
    expect(payload.input).toEqual([{ role: 'assistant', content: opening }, { role: 'user', content: followUp }]);
    expect((await sessions.getSession('session')).threadId).toBe('resp-followup');
    expect((await sessions.getSession('session')).providerState.firstAssistantMessage).toBe(opening);
    expect((await sessions.getSession('session')).providerState.openingPending).toBe(false);
    await sessions.sendMessage('session', 'Are you sure?');
    expect(create.mock.calls[2][0]).toMatchObject({ previous_response_id: 'resp-followup', input: [{ role: 'user', content: 'Are you sure?' }] });
  });

  test('Gemini sends the generated opening as model history, then chains subsequent interactions', async () => {
    const provider = new Gemini();
    const interaction = (id, text) => ({ id, status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] });
    const create = vi.fn()
      .mockResolvedValueOnce(interaction(undefined, opening))
      .mockResolvedValueOnce(interaction('followup-interaction', 'Using my AirPods.'))
      .mockResolvedValueOnce(interaction('next-interaction', 'Yes.'));
    vi.spyOn(provider, 'getClient').mockReturnValue({ interactions: { create } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia('gemini-3.1-flash-lite-preview');
    const res = response();
    await controller.sendLeiaMessage({ params: { sessionId: 'session' }, body: { message: startup, opening: true } }, res);
    expect(res.send).toHaveBeenCalledWith({ message: opening });
    expect(create.mock.calls[0][0]).toMatchObject({ input: 'Generate the opening message now.', store: false });
    expect(create.mock.calls[0][0].system_instruction).toContain(startup);
    expect(create.mock.calls[0][0]).not.toHaveProperty('previous_interaction_id');
    expect((await sessions.getSession('session')).threadId).toBe('');
    await sessions.sendMessage('session', followUp);
    const payload = create.mock.calls[1][0];
    expect(payload).not.toHaveProperty('previous_interaction_id');
    expect(payload.store).toBe(true);
    expect(payload.system_instruction).toContain(JSON.stringify(opening));
    expect(payload.system_instruction).toContain('not restarting the conversation');
    expect(payload.input).toEqual([
      { type: 'model_output', content: [{ type: 'text', text: opening }] },
      { type: 'user_input', content: [{ type: 'text', text: followUp }] },
    ]);
    const session = await sessions.getSession('session');
    expect(session.threadId).toBe('followup-interaction');
    expect(session.providerState).toMatchObject({
      firstAssistantMessage: opening, openingPending: false, previousInteractionId: 'followup-interaction',
    });
    expect(session.providerState.systemInstruction).not.toContain(opening);
    await sessions.sendMessage('session', 'Are you sure?');
    expect(create.mock.calls[2][0]).toMatchObject({ previous_interaction_id: 'followup-interaction', input: 'Are you sure?' });
    expect(create.mock.calls[2][0].system_instruction).toBe(payload.system_instruction);
  });

  test('Gemini without an opening starts with the participant and chains normally', async () => {
    const provider = new Gemini();
    const create = vi.fn()
      .mockResolvedValueOnce({ id: 'first', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Understood.' }] }] })
      .mockResolvedValueOnce({ id: 'next', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ORION.' }] }] });
    vi.spyOn(provider, 'getClient').mockReturnValue({ interactions: { create } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia(provider.name, false);
    await sessions.sendMessage('session', 'My project is called ORION.');
    await sessions.sendMessage('session', 'What is my project called?');
    expect(create.mock.calls[0][0]).toMatchObject({ input: 'My project is called ORION.', store: true });
    expect(create.mock.calls[0][0]).not.toHaveProperty('previous_interaction_id');
    expect(create.mock.calls[1][0]).toMatchObject({ input: 'What is my project called?', previous_interaction_id: 'first' });
    expect(create.mock.calls[1][0].system_instruction).toBe(create.mock.calls[0][0].system_instruction);
    expect(create.mock.calls[1][0].system_instruction).not.toContain('Dialogue grounding requirement');
    expect((await sessions.getSession('session')).providerState.firstAssistantMessage).toBeUndefined();
  });

  test('Gemini gives the opening system priority over conflicting persona rules only during startup', async () => {
    const provider = new Gemini();
    const instructions = 'Play a busy customer. Be passive. Never ask questions; let the participant lead.';
    const startupInstruction = 'Start the conversation now. Your first message must follow these instructor instructions: Hello! What should I call you?';
    const spokenOpening = 'Hello! What should I call you?';
    const create = vi.fn()
      .mockResolvedValueOnce({ steps: [{ type: 'model_output', content: [{ type: 'text', text: spokenOpening }] }] })
      .mockResolvedValueOnce({ id: 'reply', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Hello, Alex.' }] }] });
    vi.spyOn(provider, 'getClient').mockReturnValue({ interactions: { create } });
    const session = await provider.createSession({ instructions });
    const first = await provider.sendMessage({ message: startupInstruction, sessionData: session, opening: true });
    const startupPayload = create.mock.calls[0][0];
    expect(startupPayload.input).not.toContain(startupInstruction);
    expect(startupPayload.system_instruction).toContain('takes precedence over persona rules');
    expect(startupPayload.system_instruction).toContain('preserve that wording');
    expect(startupPayload.system_instruction.indexOf(startupInstruction)).toBeGreaterThan(startupPayload.system_instruction.indexOf(instructions));
    expect(first.sessionData.providerState.systemInstruction).toBe(instructions);
    await provider.sendMessage({ message: 'My name is Alex.', sessionData: first.sessionData });
    const nextPayload = create.mock.calls[1][0];
    expect(nextPayload.system_instruction).toContain(instructions);
    expect(nextPayload.system_instruction).not.toContain('Opening-turn requirement');
    expect(nextPayload.system_instruction).not.toContain(startupInstruction);
    expect(nextPayload.input).toEqual([
      { type: 'model_output', content: [{ type: 'text', text: spokenOpening }] },
      { type: 'user_input', content: [{ type: 'text', text: 'My name is Alex.' }] },
    ]);
  });

  test('Gemini reuses the actual opening on delivery retries and follow-ups', async () => {
    const actualOpening = 'Hello, I will be using my headset for this call.';
    const provider = new Gemini();
    const create = vi.fn().mockResolvedValue({
      steps: [{ type: 'model_output', content: [{ type: 'text', text: actualOpening }] }],
    });
    vi.spyOn(provider, 'getClient').mockReturnValue({ interactions: { create } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia(provider.name);
    await sessions.sendMessage('session', startup, { opening: true });
    expect(await sessions.sendMessage('session', startup, { opening: true })).toEqual({ message: actualOpening });
    expect(create).toHaveBeenCalledTimes(1);
    expect((await sessions.getSession('session')).providerState.openingPending).toBe(true);
    create.mockResolvedValueOnce({ id: 'followup', steps: [{ type: 'model_output', content: [{ type: 'text', text: actualOpening }] }] });
    await sessions.sendMessage('session', 'What did you say?');
    expect(create.mock.calls[1][0].input[0]).toEqual({ type: 'model_output', content: [{ type: 'text', text: actualOpening }] });
    expect(create.mock.calls[1][0].system_instruction).toContain(JSON.stringify(actualOpening));
    expect(create.mock.calls[1][0].system_instruction).not.toContain(opening);
  });

  test.each(['providerState', 'threadId'])('Gemini preserves existing sessions using the ID from %s and rejects a new opening', async (idSource) => {
    const provider = new Gemini();
    const create = vi.fn().mockResolvedValue({
      id: 'next', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Yes.' }] }],
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(provider, 'getClient').mockReturnValue({ interactions: { create } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia(provider.name);
    await sessions.updateSession('session', {
      threadId: idSource === 'threadId' ? 'existing' : 'fallback',
      providerState: { systemInstruction: 'Conduct an interview.', ...(idSource === 'providerState' ? { previousInteractionId: 'existing' } : {}) },
    });
    await expect(sessions.sendMessage('session', startup, { opening: true })).rejects.toThrow('Error enviando mensaje a Gemini');
    expect(create).not.toHaveBeenCalled();
    await sessions.sendMessage('session', followUp);
    expect(create.mock.calls[0][0]).toMatchObject({ input: followUp, previous_interaction_id: 'existing' });
    expect((await sessions.getSession('session')).providerState.firstAssistantMessage).toBeUndefined();
  });

  test('Gemini keeps the opening pending when the first participant request fails', async () => {
    const provider = new Gemini();
    const create = vi.fn()
      .mockResolvedValueOnce({ id: 'opening', steps: [{ type: 'model_output', content: [{ type: 'text', text: opening }] }] })
      .mockRejectedValueOnce(new Error('Temporary provider failure'))
      .mockResolvedValueOnce({ id: 'followup', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Using my AirPods.' }] }] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(provider, 'getClient').mockReturnValue({ interactions: { create } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia(provider.name);
    await sessions.sendMessage('session', startup, { opening: true });
    await expect(sessions.sendMessage('session', followUp)).rejects.toThrow('Error enviando mensaje a Gemini');
    expect((await sessions.getSession('session')).providerState.openingPending).toBe(true);
    await sessions.sendMessage('session', followUp);
    expect(create.mock.calls[2][0]).toEqual(create.mock.calls[1][0]);
    expect((await sessions.getSession('session')).providerState.openingPending).toBe(false);
  });

  test.each([
    { id: 'empty', steps: [] },
    { id: 'failed', status: 'failed', steps: [] },
  ])('Gemini does not persist an invalid opening response (%j)', async (interaction) => {
    const provider = new Gemini();
    const create = vi.fn().mockResolvedValue(interaction);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(provider, 'getClient').mockReturnValue({ interactions: { create } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia(provider.name);
    const before = await sessions.getSession('session');
    await expect(sessions.sendMessage('session', startup, { opening: true })).rejects.toThrow('Error enviando mensaje a Gemini');
    expect(await sessions.getSession('session')).toEqual(before);
  });

  test('Gemini rejects participant responses without an ID so conversation history is not lost', async () => {
    const provider = new Gemini();
    const create = vi.fn().mockResolvedValue({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Hello.' }] }] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(provider, 'getClient').mockReturnValue({ interactions: { create } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia(provider.name, false);
    const before = await sessions.getSession('session');
    await expect(sessions.sendMessage('session', 'Hello')).rejects.toThrow('Error enviando mensaje a Gemini');
    expect(await sessions.getSession('session')).toEqual(before);
  });

  test('Ollama receives the actual opening as an assistant message before the follow-up', async () => {
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
      .mockResolvedValueOnce({ message: { content: opening } })
      .mockResolvedValueOnce({ message: { content: 'Using my AirPods.' } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia('ollama');
    await sessions.sendMessage('session', startup, { opening: true });
    await sessions.sendMessage('session', followUp);
    const messages = completion.mock.calls[1][0].messages;
    expect(messages[0]).toEqual({ role: 'system', content: expect.any(String) });
    expect(messages.slice(-2)).toEqual([
      { role: 'assistant', content: opening },
      { role: 'user', content: followUp },
    ]);
  });

  test('opening text is conversation history rather than a permanent system instruction', async () => {
    vi.spyOn(manager, 'getModel').mockResolvedValue(new OpenAI());
    await createLeia('openai-responses');
    const session = await sessions.getSession('session');
    expect(session.providerState.systemInstruction).not.toContain(opening);
  });

  test('existing Conversations sessions continue from their saved last response', async () => {
    const provider = new OpenAI();
    const create = vi.fn().mockResolvedValue({ id: 'resp-next', output_text: 'My AirPods.' });
    vi.spyOn(provider, 'getClient').mockReturnValue({ responses: { create } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia('openai-responses');
    await sessions.updateSession('session', {
      threadId: 'conv-existing', providerState: {
        systemInstruction: 'Keep the interview brief.', conversationId: 'conv-existing', lastResponseId: 'resp-existing-opening',
      },
    });
    await sessions.sendMessage('session', followUp);
    expect(create.mock.calls[0][0]).toMatchObject({ previous_response_id: 'resp-existing-opening' });
    expect(create.mock.calls[0][0]).not.toHaveProperty('conversation');
  });

  test('tool continuations extend the same response chain without dropping the opening', async () => {
    const provider = new OpenAI();
    const create = vi.fn()
      .mockResolvedValueOnce({ id: 'resp-opening', output_text: opening })
      .mockResolvedValueOnce({ id: 'resp-tool', output: [{ type: 'function_call', call_id: 'call-read', name: 'read', arguments: '{}' }] })
      .mockResolvedValueOnce({ id: 'resp-final', output_text: 'Done.' });
    vi.spyOn(provider, 'getClient').mockReturnValue({ responses: { create } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia('openai-responses');
    await sessions.storeLeiaMeta('session', { toolFunctionsEnabled: 'true' });
    await sessions.sendMessage('session', startup, { opening: true });
    await sessions.sendMessage('session', 'Read the editor', { tools: [{ name: 'read' }] });
    await sessions.sendMessage('session', null, { toolResults: [{ callId: 'call-read', output: 'editor content' }] });
    expect(create.mock.calls[1][0]).toMatchObject({ input: [{ role: 'assistant', content: opening }, { role: 'user', content: 'Read the editor' }] });
    expect(create.mock.calls[2][0]).toMatchObject({
      previous_response_id: 'resp-tool',
      input: [{ type: 'function_call_output', call_id: 'call-read', output: 'editor content' }],
    });
    expect((await sessions.getSession('session')).providerState.lastResponseId).toBe('resp-final');
    expect((await sessions.getSession('session')).providerState.firstAssistantMessage).toBe(opening);
  });

  test('uses the generated opening as evidence rather than the configured opening directions', async () => {
    const actualOpening = 'Hello, I will be using my headset for this call.';
    const provider = new OpenAI();
    const create = vi.fn()
      .mockResolvedValueOnce({ id: 'resp-opening', output_text: actualOpening })
      .mockResolvedValueOnce({ id: 'resp-recall', output_text: actualOpening });
    vi.spyOn(provider, 'getClient').mockReturnValue({ responses: { create } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia('openai-responses');
    await sessions.sendMessage('session', startup, { opening: true });
    await sessions.sendMessage('session', 'What did you say?');
    const instructions = create.mock.calls[1][0].instructions;
    expect(instructions).toContain(JSON.stringify(actualOpening));
    expect(instructions).not.toContain(opening);
    expect((await sessions.getSession('session')).providerState.systemInstruction).not.toContain(actualOpening);
  });

  test('legacy sessions without a response ID bridge once through their conversation', async () => {
    const provider = new OpenAI();
    const create = vi.fn()
      .mockResolvedValueOnce({ id: 'resp-bridge', output_text: 'My AirPods.' })
      .mockResolvedValueOnce({ id: 'resp-next', output_text: 'Yes.' });
    vi.spyOn(provider, 'getClient').mockReturnValue({ responses: { create } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia('openai-responses');
    await sessions.updateSession('session', { threadId: 'conv_existing' });
    await sessions.sendMessage('session', followUp);
    await sessions.sendMessage('session', 'Are you sure?');
    expect(create.mock.calls[0][0]).toMatchObject({ conversation: 'conv_existing' });
    expect(create.mock.calls[0][0]).not.toHaveProperty('previous_response_id');
    expect(create.mock.calls[1][0]).toMatchObject({ previous_response_id: 'resp-bridge' });
    expect(create.mock.calls[1][0]).not.toHaveProperty('conversation');
    // The first post-migration reply is not mislabelled as the original opening.
    expect((await sessions.getSession('session')).providerState.firstAssistantMessage).toBeUndefined();
  });

  test('retries opening delivery without generating another opening', async () => {
    const provider = new OpenAI();
    const create = vi.fn().mockResolvedValue({ id: 'resp-opening', output_text: opening });
    vi.spyOn(provider, 'getClient').mockReturnValue({ responses: { create } });
    vi.spyOn(manager, 'getModel').mockResolvedValue(provider);
    await createLeia('openai-responses');
    await sessions.sendMessage('session', startup, { opening: true });
    expect(await sessions.sendMessage('session', startup, { opening: true })).toEqual({ message: opening });
    expect(create).toHaveBeenCalledTimes(1);
    expect((await sessions.getSession('session')).providerState.openingPending).toBe(true);
  });
});
