import { describe, expect, beforeAll, afterAll, test } from 'vitest';
import { z } from 'zod';
import 'dotenv/config';
import structuredGenerationService from '../services/structuredGenerationService';
import OpenAIResponsesProvider from '../models/providers/openai-responses';
import GeminiProvider from '../models/providers/gemini-3.1-flash-lite-preview';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// Set by CI on pull requests from forks, which get no secrets: a missing key
// skips that provider's test instead of failing it.
const PROVIDER_KEYS_OPTIONAL = process.env.PROVIDER_KEYS_OPTIONAL === 'true';

const openaiResponsesProvider = new OpenAIResponsesProvider();
const geminiProvider = new GeminiProvider();

const MiniEvaluationSchema = z.object({
  score: z.number().min(0).max(10),
  feedback: z.string().min(1),
  suggestions: z.array(z.string()).min(1),
});

const MiniEvaluationResponseFormat = {
  type: 'object',
  properties: {
    score: { type: 'number', minimum: 0, maximum: 10 },
    feedback: { type: 'string' },
    suggestions: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['score', 'feedback', 'suggestions'],
};

async function assertSessionLifecycle(provider, { instructions, message }) {
  const sessionData = await provider.createSession({ instructions });

  expect(sessionData).toEqual({
    providerState: {
      systemInstruction: instructions,
    },
    threadId: '',
  });

  const response = await provider.sendMessage({
    message,
    sessionData,
  });

  expect(response).toEqual(
    expect.objectContaining({
      message: expect.any(String),
      sessionData: expect.any(Object),
    })
  );
  expect(response.message.trim()).toBeTruthy();
  expect(response.sessionData).toEqual(
    expect.objectContaining({
      threadId: expect.any(String),
      providerState: expect.any(Object),
    })
  );
  expect(response.sessionData.providerState.systemInstruction).toBe(instructions);
  // threadId is empty after createSession; after the first sendMessage it should be assigned
  expect(response.sessionData.threadId).not.toBe('');

  return response;
}

let originalProvider;

async function runWithSchemaRetry(action, { maxAttempts = 3 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const isSchemaRangeError =
        message.includes('too_big') ||
        message.includes('too_small') ||
        message.includes('Number must be less than or equal to') ||
        message.includes('Number must be greater than or equal to');

      if (!isSchemaRangeError || attempt === maxAttempts) {
        break;
      }
    }
  }

  throw lastError;
}

// Before all tests, store the original AI_PROVIDER value to restore it later
beforeAll(() => {
  originalProvider = process.env.AI_PROVIDER;
  if (OPENAI_API_KEY) {
    openaiResponsesProvider.setApiKey(OPENAI_API_KEY);
  }
  if (GEMINI_API_KEY) {
    geminiProvider.setApiKey(GEMINI_API_KEY);
  }
});
// After all tests, restore the original AI_PROVIDER value to avoid affecting other tests or the environment
afterAll(() => {
  if (typeof originalProvider === 'undefined') {
    delete process.env.AI_PROVIDER;
    return;
  }

  process.env.AI_PROVIDER = originalProvider;
});

describe('LLM integration tests', () => {
  test.skipIf(PROVIDER_KEYS_OPTIONAL && !OPENAI_API_KEY)('calls OpenAI structured endpoint successfully', { timeout: 120000 }, async () => {
    process.env.AI_PROVIDER = 'openai';

    const result = await runWithSchemaRetry(async () =>
      structuredGenerationService.generateObject({
        systemPrompt: 'You are a strict evaluator. Return compact, structured JSON only.',
        userPrompt:
          'Evaluate: student says 2+2=4. expected is 4. Return score, short feedback and one suggestion.',
        zodSchema: MiniEvaluationSchema,
        schemaName: 'mini_evaluation',
        openaiModel: OPENAI_MODEL,
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        score: expect.any(Number),
        feedback: expect.any(String),
        suggestions: expect.any(Array),
      })
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(10);
    expect(result.suggestions.length).toBeGreaterThan(0);

    await assertSessionLifecycle(openaiResponsesProvider, {
      instructions: 'You are a concise assistant that answers briefly.',
      message: 'Reply with a short confirmation that the session flow works.',
    });
  });

  test.skipIf(PROVIDER_KEYS_OPTIONAL && !GEMINI_API_KEY)('calls Gemini structured endpoint successfully', { timeout: 120000 }, async () => {
    process.env.AI_PROVIDER = 'gemini';

    const result = await runWithSchemaRetry(async () =>
      structuredGenerationService.generateObject({
        systemPrompt: 'You are a strict evaluator. Return compact, structured JSON only.',
        userPrompt:
          'Evaluate: student says Earth is round. expected is Earth is round. Return score, feedback and one suggestion.',
        zodSchema: MiniEvaluationSchema,
        schemaName: 'mini_evaluation',
        geminiModel: GEMINI_MODEL,
        geminiResponseFormat: MiniEvaluationResponseFormat,
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        score: expect.any(Number),
        feedback: expect.any(String),
        suggestions: expect.any(Array),
      })
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(10);
    expect(result.suggestions.length).toBeGreaterThan(0);

    await assertSessionLifecycle(geminiProvider, {
      instructions: 'You are a concise assistant that answers briefly.',
      message: 'Reply with a short confirmation that the session flow works.',
    });
  });
});
