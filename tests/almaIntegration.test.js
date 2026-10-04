import { describe, expect, beforeAll, test, vi } from 'vitest';
import { createRequire } from 'module';
import { z } from 'zod';
import 'dotenv/config';

// Real calls to ALMA. In production the key comes from leia-auth (BYOK); here it
// is read from ALMA_API_KEY so the suite can run locally. Without a key the suite
// is skipped. ALMA_BASE_URL and ALMA_MODEL select the model (see .env.example).
const require = createRequire(import.meta.url);
const AlmaProvider = require('../models/providers/alma');

const ALMA_API_KEY = process.env.ALMA_API_KEY || '';

const EvaluationSchema = z.object({
  score: z.number().min(0).max(10),
  evaluation: z.string().min(1),
});

// In-memory stand-in for the Redis-backed ConversationStore, so the suite only
// needs ALMA and not a running Redis.
function useInMemoryHistory(provider) {
  const history = new Map();

  vi.spyOn(provider.conversationStore, 'buildConversationForRequest').mockImplementation(
    async (sessionId, systemInstruction, userMessage) => {
      const messages = history.get(sessionId) || [{ role: 'system', content: systemInstruction }];
      messages.push({ role: 'user', content: userMessage });
      history.set(sessionId, messages);
      return [...messages];
    }
  );
  vi.spyOn(provider.conversationStore, 'storeAssistantResponse').mockImplementation(
    async (sessionId, assistantMessage) => {
      history.get(sessionId).push({ role: 'assistant', content: assistantMessage });
    }
  );

  return history;
}

describe.skipIf(!ALMA_API_KEY)('ALMA integration tests', () => {
  let provider;
  let history;

  beforeAll(() => {
    provider = new AlmaProvider();
    provider.setApiKey(ALMA_API_KEY);
    history = useInMemoryHistory(provider);
  });

  test('creates a session and answers a message', { timeout: 120000 }, async () => {
    const sessionId = `alma-it-${Date.now()}`;
    const instructions = 'You are a helpful assistant. Reply concisely.';

    const sessionData = await provider.createSession({ instructions });
    const response = await provider.sendMessage({
      sessionId,
      message: 'Hello! What is 2+2?',
      sessionData,
    });

    expect(typeof response.message).toBe('string');
    expect(response.message.length).toBeGreaterThan(0);
    expect(response.sessionData.threadId).toBe(sessionId);
    expect(response.sessionData.providerState.systemInstruction).toBe(instructions);
    expect(history.get(sessionId).at(-1)).toEqual({ role: 'assistant', content: response.message });
  });

  test('returns a structured evaluation', { timeout: 120000 }, async () => {
    const prompt = `
Evaluate the following solution for a problem:

Expected solution:
4

Provided solution:
4

The Format to compare is:
number

Evaluate the provided solution by comparing it with the expected solution.
Assign a score between 0 and 10, where:
- 10 means the solution is perfect
- 0 means the solution is completely incorrect
Provide a detailed evaluation in Markdown format.

Respond ONLY with a JSON object in the following format:
{
  "score": [score between 0 and 10],
  "evaluation": "[detailed evaluation in Markdown format]"
}`;

    const response = await provider.generateEvaluationResponse(prompt);
    const parsed = EvaluationSchema.parse(response);

    expect(parsed.score).toBeGreaterThanOrEqual(0);
    expect(parsed.score).toBeLessThanOrEqual(10);
  });

  test('rejects an evaluation that is not JSON', { timeout: 120000 }, async () => {
    const prompt = 'Please reply ONLY with the word "Hello". Do not use JSON format.';

    await expect(provider.generateEvaluationResponse(prompt)).rejects.toThrow(
      'Error evaluating the solution with ALMA'
    );
  });
});
