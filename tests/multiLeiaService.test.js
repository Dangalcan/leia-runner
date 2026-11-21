import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const multiLeiaService = require('../services/multiLeiaService');
const sessionService = require('../services/sessionService');
const modelManager = require('../models/modelManager');
const { redisClient } = require('../config/redis');

function orchestratorToolCall(index, callId, instruction, targetId = 'participant') {
  return {
    toolCalls: [
      {
        callId,
        name: `speak_as_leia_${index}`,
        arguments: JSON.stringify({ targetId, instruction }),
      },
    ],
  };
}

function mockTurnPlan(overrides = {}) {
  const plan = {
    audience: 'individual',
    mode: 'single_reply',
    minimumMessages: 1,
    requiredActorIds: [],
    openingActorId: 'actor-a',
    rationale: 'A single role can answer this turn.',
    ...overrides,
  };
  return vi.spyOn(multiLeiaService, 'sendCoordinatorTurnPlan').mockResolvedValue({
    toolCalls: [
      {
        callId: 'plan-call',
        name: 'plan_multi_leia_turn',
        arguments: JSON.stringify(plan),
      },
    ],
  });
}

function createRuntime(maxInternalTurns = 2) {
  return {
    version: 1,
    sessionId: 'session-1',
    status: 'awaiting_user',
    actors: [
      { id: 'actor-a', name: 'Actor A', sessionId: 'session-1:actor:actor-a', cursor: 0 },
      { id: 'actor-b', name: 'Actor B', sessionId: 'session-1:actor:actor-b', cursor: 0 },
    ],
    graph: {},
    orchestration: {
      maxInternalTurns,
      openingActorId: 'actor-a',
      problemActorId: 'actor-a',
      sharedTask: 'Solve the shared task',
      routerSessionId: 'session-1:orchestrator',
    },
    nextActorIndex: 0,
    sequence: 0,
    transcript: [],
    processedTurns: [],
    traversal: [],
    lastPartial: null,
  };
}

describe('MultiLEIA partial traversal recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps completed messages and retries from the failed actor next turn', async () => {
    const runtime = createRuntime();
    let lockToken = null;

    mockTurnPlan({
      audience: 'whole_group',
      mode: 'agent_discussion',
      minimumMessages: 2,
      requiredActorIds: ['actor-a', 'actor-b'],
    });

    vi.spyOn(redisClient, 'set').mockImplementation(async (key, value) => {
      if (key.startsWith('multi-leia:lock:')) lockToken = value;
      return 'OK';
    });
    vi.spyOn(redisClient, 'get').mockImplementation(async (key) =>
      key.startsWith('multi-leia:lock:') ? lockToken : null
    );
    vi.spyOn(redisClient, 'del').mockResolvedValue(1);
    vi.spyOn(multiLeiaService, 'getRuntime').mockResolvedValue(runtime);
    vi.spyOn(multiLeiaService, 'saveRuntime').mockImplementation(async (value) => value);
    vi.spyOn(sessionService, 'sendMessage')
      .mockResolvedValueOnce({ message: '{"nextSpeakerId":"actor-a"}' })
      .mockResolvedValueOnce({ message: 'Actor A response' })
      .mockResolvedValueOnce({ message: '{"nextSpeakerId":"actor-b"}' })
      .mockRejectedValueOnce(new Error('Provider unavailable'));
    const onMessage = vi.fn();

    const result = await multiLeiaService.sendMessage(
      runtime.sessionId,
      'Participant message',
      'turn-1',
      { onMessage }
    );

    expect(result.partial).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      senderId: 'actor-a',
      text: 'Actor A response',
      turnId: 'turn-1',
    });
    expect(result.state).toMatchObject({
      status: 'awaiting_user',
      nextActorId: 'actor-b',
      lastPartial: {
        turnId: 'turn-1',
        actorId: 'actor-b',
        actorName: 'Actor B',
      },
    });
    expect(runtime.transcript.map((event) => event.senderId)).toEqual([
      'participant',
      'actor-a',
    ]);
    expect(runtime.processedTurns).toEqual([
      { turnId: 'turn-1', messages: result.messages },
    ]);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(result.messages[0]);
  });

  it('lets two LEIAs speak more than twice until the orchestrator returns control', async () => {
    const runtime = createRuntime(6);
    let lockToken = null;

    mockTurnPlan({
      mode: 'agent_discussion',
      minimumMessages: 3,
      requiredActorIds: ['actor-a', 'actor-b'],
    });

    vi.spyOn(redisClient, 'set').mockImplementation(async (key, value) => {
      if (key.startsWith('multi-leia:lock:')) lockToken = value;
      return 'OK';
    });
    vi.spyOn(redisClient, 'get').mockImplementation(async (key) =>
      key.startsWith('multi-leia:lock:') ? lockToken : null
    );
    vi.spyOn(redisClient, 'del').mockResolvedValue(1);
    vi.spyOn(multiLeiaService, 'getRuntime').mockResolvedValue(runtime);
    vi.spyOn(multiLeiaService, 'saveRuntime').mockImplementation(async (value) => value);
    vi.spyOn(sessionService, 'sendMessage')
      .mockResolvedValueOnce(orchestratorToolCall(1, 'call-a1', 'Open the discussion'))
      .mockResolvedValueOnce({ message: 'Actor A opens' })
      .mockResolvedValueOnce(
        orchestratorToolCall(2, 'call-b1', 'Respond to Actor A', 'actor-a')
      )
      .mockResolvedValueOnce({ message: 'Actor B responds' })
      .mockResolvedValueOnce(
        orchestratorToolCall(1, 'call-a2', 'Follow up', 'actor-b')
      )
      .mockResolvedValueOnce({ message: 'Actor A follows up' })
      .mockResolvedValueOnce({ message: 'WAIT_FOR_PARTICIPANT' });
    const onRoute = vi.fn();
    const onMessage = vi.fn();

    const result = await multiLeiaService.sendMessage(
      runtime.sessionId,
      'Start the discussion',
      'turn-long',
      { onRoute, onMessage }
    );

    expect(result.partial).toBeUndefined();
    expect(result.messages.map((message) => message.senderId)).toEqual([
      'actor-a',
      'actor-b',
      'actor-a',
    ]);
    expect(result.messages.map((message) => message.text)).toEqual([
      'Actor A opens',
      'Actor B responds',
      'Actor A follows up',
    ]);
    expect(onRoute).toHaveBeenCalledTimes(3);
    expect(onMessage).toHaveBeenCalledTimes(3);
    expect(runtime.transcript.map((event) => event.senderId)).toEqual([
      'participant',
      'actor-a',
      'actor-b',
      'actor-a',
    ]);
    expect(runtime.transcript.slice(1).map((event) => event.addressedToId)).toEqual([
      'participant',
      'actor-a',
      'actor-b',
    ]);
    expect(runtime.status).toBe('awaiting_user');
    expect(sessionService.sendMessage).toHaveBeenNthCalledWith(
      3,
      'session-1:orchestrator',
      '',
      expect.objectContaining({
        internalTools: true,
        parallelToolCalls: false,
        toolResults: [
          expect.objectContaining({
            callId: 'call-a1',
            output: expect.objectContaining({
              status: 'published',
              senderId: 'actor-a',
            }),
          }),
        ],
      })
    );
  });

  it('stops after one LEIA when the orchestrator returns control to the participant', async () => {
    const runtime = createRuntime(6);
    let lockToken = null;

    mockTurnPlan({ openingActorId: 'actor-b' });

    vi.spyOn(redisClient, 'set').mockImplementation(async (key, value) => {
      if (key.startsWith('multi-leia:lock:')) lockToken = value;
      return 'OK';
    });
    vi.spyOn(redisClient, 'get').mockImplementation(async (key) =>
      key.startsWith('multi-leia:lock:') ? lockToken : null
    );
    vi.spyOn(redisClient, 'del').mockResolvedValue(1);
    vi.spyOn(multiLeiaService, 'getRuntime').mockResolvedValue(runtime);
    vi.spyOn(multiLeiaService, 'saveRuntime').mockImplementation(async (value) => value);
    vi.spyOn(sessionService, 'sendMessage')
      .mockResolvedValueOnce(orchestratorToolCall(2, 'call-b1', 'Answer the greeting'))
      .mockResolvedValueOnce({ message: 'Hello, how can I help?' })
      .mockResolvedValueOnce({ message: 'WAIT_FOR_PARTICIPANT' });

    const result = await multiLeiaService.sendMessage(
      runtime.sessionId,
      'Hello',
      'turn-short'
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      senderId: 'actor-b',
      text: 'Hello, how can I help?',
    });
    expect(runtime.transcript.map((event) => event.senderId)).toEqual([
      'participant',
      'actor-b',
    ]);
  });

  it('streams a separate introduction from every LEIA addressed by a group question', async () => {
    const runtime = createRuntime(6);
    let lockToken = null;

    mockTurnPlan({
      audience: 'whole_group',
      mode: 'multiple_perspectives',
      minimumMessages: 2,
      requiredActorIds: ['actor-a', 'actor-b'],
      rationale: 'The participant asked the whole group who they are.',
    });

    vi.spyOn(redisClient, 'set').mockImplementation(async (key, value) => {
      if (key.startsWith('multi-leia:lock:')) lockToken = value;
      return 'OK';
    });
    vi.spyOn(redisClient, 'get').mockImplementation(async (key) =>
      key.startsWith('multi-leia:lock:') ? lockToken : null
    );
    vi.spyOn(redisClient, 'del').mockResolvedValue(1);
    vi.spyOn(multiLeiaService, 'getRuntime').mockResolvedValue(runtime);
    vi.spyOn(multiLeiaService, 'saveRuntime').mockImplementation(async (value) => value);
    vi.spyOn(sessionService, 'sendMessage')
      .mockResolvedValueOnce(orchestratorToolCall(1, 'intro-a', 'Introduce yourself'))
      .mockResolvedValueOnce({ message: 'I am Actor A.' })
      .mockResolvedValueOnce(orchestratorToolCall(2, 'intro-b', 'Introduce yourself too'))
      .mockResolvedValueOnce({ message: 'I am Actor B.' })
      .mockResolvedValueOnce({ message: 'WAIT_FOR_PARTICIPANT' });
    const onMessage = vi.fn();

    const result = await multiLeiaService.sendMessage(
      runtime.sessionId,
      'Who are you?',
      'turn-introductions',
      { onMessage }
    );

    expect(result.messages.map((message) => message.text)).toEqual([
      'I am Actor A.',
      'I am Actor B.',
    ]);
    expect(onMessage.mock.calls.map(([message]) => message.senderId)).toEqual([
      'actor-a',
      'actor-b',
    ]);
    expect(sessionService.sendMessage).toHaveBeenNthCalledWith(
      1,
      'session-1:orchestrator',
      '',
      expect.objectContaining({
        toolChoice: { type: 'function', name: 'speak_as_leia_1' },
      })
    );
  });

  it('completes the semantic LLM plan when the coordinator tries to stop early', async () => {
    const runtime = createRuntime(4);
    let lockToken = null;

    mockTurnPlan({
      audience: 'whole_group',
      mode: 'agent_discussion',
      minimumMessages: 2,
      requiredActorIds: ['actor-a', 'actor-b'],
      rationale: 'Both roles are needed and should respond to each other.',
    });
    vi.spyOn(redisClient, 'set').mockImplementation(async (key, value) => {
      if (key.startsWith('multi-leia:lock:')) lockToken = value;
      return 'OK';
    });
    vi.spyOn(redisClient, 'get').mockImplementation(async (key) =>
      key.startsWith('multi-leia:lock:') ? lockToken : null
    );
    vi.spyOn(redisClient, 'del').mockResolvedValue(1);
    vi.spyOn(multiLeiaService, 'getRuntime').mockResolvedValue(runtime);
    vi.spyOn(multiLeiaService, 'saveRuntime').mockImplementation(async (value) => value);
    vi.spyOn(sessionService, 'sendMessage')
      .mockResolvedValueOnce(orchestratorToolCall(1, 'first', 'Start the answer'))
      .mockResolvedValueOnce({ message: 'Actor A explains their role.' })
      .mockResolvedValueOnce({ message: 'WAIT_FOR_PARTICIPANT' })
      .mockResolvedValueOnce({ message: 'Actor B reacts with their distinct role.' })
      .mockResolvedValueOnce({ message: 'WAIT_FOR_PARTICIPANT' });

    const result = await multiLeiaService.sendMessage(
      runtime.sessionId,
      'What does everyone here do?',
      'turn-enforced-plan'
    );

    expect(result.messages.map((event) => event.senderId)).toEqual([
      'actor-a',
      'actor-b',
    ]);
    expect(result.messages[1]).toMatchObject({
      addressedToId: 'actor-a',
      addressedToName: 'Actor A',
    });
    expect(sessionService.sendMessage).toHaveBeenNthCalledWith(
      4,
      'session-1:actor:actor-b',
      expect.stringContaining('React directly to what Actor A just said')
    );
  });

  it('executes the accepted LLM plan when its tool-call continuation fails', async () => {
    const runtime = createRuntime(2);
    let lockToken = null;

    mockTurnPlan({
      audience: 'whole_group',
      mode: 'multiple_perspectives',
      minimumMessages: 2,
      requiredActorIds: ['actor-a', 'actor-b'],
      rationale: 'Both group members should identify themselves.',
    });
    vi.spyOn(redisClient, 'set').mockImplementation(async (key, value) => {
      if (key.startsWith('multi-leia:lock:')) lockToken = value;
      return 'OK';
    });
    vi.spyOn(redisClient, 'get').mockImplementation(async (key) =>
      key.startsWith('multi-leia:lock:') ? lockToken : null
    );
    vi.spyOn(redisClient, 'del').mockResolvedValue(1);
    vi.spyOn(multiLeiaService, 'getRuntime').mockResolvedValue(runtime);
    vi.spyOn(multiLeiaService, 'saveRuntime').mockImplementation(async (value) => value);
    vi.spyOn(sessionService, 'sendMessage')
      .mockRejectedValueOnce(new Error('Empty coordinator continuation'))
      .mockResolvedValueOnce({ message: 'I am Actor A.' })
      .mockResolvedValueOnce({ message: 'And I am Actor B.' });

    const result = await multiLeiaService.sendMessage(
      runtime.sessionId,
      'Who is here?',
      'turn-plan-fallback'
    );

    expect(result.messages.map((event) => event.senderId)).toEqual([
      'actor-a',
      'actor-b',
    ]);
    expect(result.messages[1]).toMatchObject({ addressedToId: 'actor-a' });
  });

  it('enables trusted coordinator tools without activity widgets', async () => {
    const providerSendMessage = vi.fn().mockResolvedValue({ message: 'done' });
    vi.spyOn(sessionService, 'getSession').mockResolvedValue({
      provider: 'openai-responses',
      modelName: 'gpt-5.4-mini',
      apiKeyId: 'key-id',
      apiKeyRequesterId: 'requester-id',
      threadId: '',
    });
    vi.spyOn(sessionService, 'getLeiaMeta').mockResolvedValue(null);
    vi.spyOn(modelManager, 'getModel').mockResolvedValue({
      sendMessage: providerSendMessage,
    });

    await sessionService.sendMessage('session-1:orchestrator', 'Coordinate', {
      tools: [{ name: 'speak_as_leia_1', parameters: { type: 'object' } }],
      internalTools: true,
      parallelToolCalls: false,
    });

    expect(providerSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        allowTools: true,
        internalTools: true,
        parallelToolCalls: false,
        tools: [expect.objectContaining({ name: 'speak_as_leia_1' })],
      })
    );
  });

  it('lets the coordinator recover by calling another LEIA when one tool fails', async () => {
    const runtime = createRuntime(2);
    let lockToken = null;

    mockTurnPlan();

    vi.spyOn(redisClient, 'set').mockImplementation(async (key, value) => {
      if (key.startsWith('multi-leia:lock:')) lockToken = value;
      return 'OK';
    });
    vi.spyOn(redisClient, 'get').mockImplementation(async (key) =>
      key.startsWith('multi-leia:lock:') ? lockToken : null
    );
    vi.spyOn(redisClient, 'del').mockResolvedValue(1);
    vi.spyOn(multiLeiaService, 'getRuntime').mockResolvedValue(runtime);
    vi.spyOn(multiLeiaService, 'saveRuntime').mockImplementation(async (value) => value);
    vi.spyOn(sessionService, 'sendMessage')
      .mockResolvedValueOnce(orchestratorToolCall(1, 'failed-a', 'Answer first'))
      .mockRejectedValueOnce(new Error('Actor A unavailable'))
      .mockResolvedValueOnce(orchestratorToolCall(2, 'recover-b', 'Answer instead'))
      .mockResolvedValueOnce({ message: 'Actor B recovered the conversation' })
      .mockResolvedValueOnce({ message: 'WAIT_FOR_PARTICIPANT' });

    const result = await multiLeiaService.sendMessage(
      runtime.sessionId,
      'Can somebody help?',
      'turn-recovery'
    );

    expect(result.partial).toBeUndefined();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      senderId: 'actor-b',
      text: 'Actor B recovered the conversation',
    });
    expect(sessionService.sendMessage).toHaveBeenNthCalledWith(
      3,
      'session-1:orchestrator',
      '',
      expect.objectContaining({
        toolResults: [
          expect.objectContaining({
            callId: 'failed-a',
            output: expect.objectContaining({ status: 'error' }),
          }),
        ],
      })
    );
  });
});
