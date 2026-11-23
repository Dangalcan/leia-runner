import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

// The runner is CommonJS: load the provider with the native require so the
// test and the provider share the same module cache.
const require = createRequire(import.meta.url);
const AlmaProvider = require('../models/providers/alma');

const API_KEY = 'alma-test-key';
const BASE_URL = 'https://alma.example.test/api/models/test-model/v1';

function okResponse(content) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

function lastRequest() {
  const [url, init] = global.fetch.mock.calls.at(-1);
  return { url, init, body: JSON.parse(init.body) };
}

describe('ALMA Provider Unit Tests', () => {
  let originalFetch;
  let provider;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn();

    vi.stubEnv('ALMA_BASE_URL', BASE_URL);
    vi.stubEnv('ALMA_MODEL', 'example/Primary-Model');
    provider = new AlmaProvider();
    provider.setApiKey(API_KEY);

    vi.spyOn(provider.conversationStore, 'buildConversationForRequest').mockResolvedValue([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'Hello' },
    ]);
    vi.spyOn(provider.conversationStore, 'storeAssistantResponse').mockResolvedValue();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('BYOK contract', () => {
    test('exports a class that declares the alma API key provider', () => {
      expect(typeof AlmaProvider).toBe('function');
      expect(provider.name).toBe('alma');
      expect(provider.apiKeyProvider).toBe('alma');
      expect(typeof provider.model).toBe('string');
      expect(provider.model.length).toBeGreaterThan(0);
    });

    test('falls back to the public ALMA defaults when no env is set', () => {
      vi.stubEnv('ALMA_BASE_URL', '');
      vi.stubEnv('ALMA_MODEL', '');
      vi.stubEnv('ALMA_MAX_TOKENS', '');
      vi.stubEnv('ALMA_EVALUATION_MAX_TOKENS', '');

      const defaults = new AlmaProvider();

      expect(defaults.baseUrl).toBe('https://alma.us.es/api/models/llama-3.1-8b-instruct/v1');
      expect(defaults.model).toBe('meta-llama/Llama-3.1-8B-Instruct');
      expect(defaults.maxTokens).toBe(1024);
      expect(defaults.evaluationMaxTokens).toBe(2048);
    });

    test('reads the base URL and the model from the environment', () => {
      vi.stubEnv('ALMA_BASE_URL', 'https://alma.example.test/api/models/qwen/v1/');
      vi.stubEnv('ALMA_MODEL', 'Qwen/Qwen2.5-14B-Instruct');

      const fromEnv = new AlmaProvider();

      expect(fromEnv.baseUrl).toBe('https://alma.example.test/api/models/qwen/v1');
      expect(fromEnv.model).toBe('Qwen/Qwen2.5-14B-Instruct');
    });
  });

  describe('sendMessage', () => {
    const defaultOptions = {
      sessionId: 'test-session',
      message: 'Hello',
      sessionData: { threadId: '', providerState: { systemInstruction: 'system prompt' } },
    };

    test('sends the conversation to {baseUrl}/chat/completions with the apikey header', async () => {
      global.fetch.mockResolvedValueOnce(okResponse('  Hi there!  '));

      const response = await provider.sendMessage(defaultOptions);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const { url, init, body } = lastRequest();
      expect(url).toBe(`${BASE_URL}/chat/completions`);
      expect(init.method).toBe('POST');
      expect(init.headers.apikey).toBe(API_KEY);
      expect(body.model).toBe(provider.model);
      expect(body.max_tokens).toBe(provider.maxTokens);
      expect(body.messages).toEqual([
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'Hello' },
      ]);

      expect(response.message).toBe('Hi there!');
      expect(provider.conversationStore.storeAssistantResponse).toHaveBeenCalledWith('test-session', 'Hi there!');
    });

    test('returns session data that keeps the system instruction and points at the history', async () => {
      global.fetch.mockResolvedValueOnce(okResponse('Hi there!'));

      const { sessionData } = await provider.sendMessage(defaultOptions);

      expect(sessionData.threadId).toBe('test-session');
      expect(sessionData.providerState.systemInstruction).toBe('system prompt');
      expect(sessionData.providerState.conversationKey).toBe(
        provider.conversationStore.getConversationKey('test-session')
      );
      expect(sessionData.providerState.model).toBe(provider.model);
    });

    test('discovers and caches the model ID for the base URL selected by the API key', async () => {
      const url = 'https://alma.example.test/api/models/other-model/v1';
      provider.setBaseURL(`${url}/`);
      global.fetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'example/Other-Model' }] }) })
        .mockResolvedValue(okResponse('Hi'));

      await provider.sendMessage(defaultOptions);
      await provider.sendMessage(defaultOptions);

      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(global.fetch).toHaveBeenNthCalledWith(1, `${url}/models`, expect.objectContaining({
        headers: { apikey: API_KEY }, redirect: 'error',
      }));
      expect(lastRequest()).toMatchObject({
        url: `${url}/chat/completions`, body: { model: 'example/Other-Model' },
        init: { redirect: 'error' },
      });
    });

    test('uses the discovered model even when a key selects the fallback URL', async () => {
      provider.setBaseURL(BASE_URL);
      global.fetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'example/Discovered' }] }) })
        .mockResolvedValueOnce(okResponse('Hi'));
      await provider.sendMessage(defaultOptions);
      expect(lastRequest().body.model).toBe('example/Discovered');
    });

    test('rejects a model URL outside the configured ALMA origins', () => {
      expect(() => provider.setBaseURL('https://other.example.test/api/models/model/v1')).toThrow('configured ALMA origin');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('retries model discovery after a transient failure', async () => {
      provider.setBaseURL('https://alma.us.es/api/models/other-model/v1');
      global.fetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'example/Other-Model' }] }) })
        .mockResolvedValueOnce(okResponse('Hi'));
      await expect(provider.sendMessage(defaultOptions)).rejects.toThrow('Error sending message to ALMA');
      await expect(provider.sendMessage(defaultOptions)).resolves.toMatchObject({ message: 'Hi' });
    });

    test('rejects with 400 when sessionId is missing, before calling ALMA', async () => {
      await expect(provider.sendMessage({ ...defaultOptions, sessionId: undefined })).rejects.toMatchObject({
        status: 400,
        message: 'sessionId is required to use ALMA provider',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('does not call ALMA when no API key was injected', async () => {
      provider.setApiKey(null);

      await expect(provider.sendMessage(defaultOptions)).rejects.toThrow('Error sending message to ALMA');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('throws messageSendError when fetch fails', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(provider.sendMessage(defaultOptions)).rejects.toThrow('Error sending message to ALMA');
    });

    test('throws messageSendError when the API returns a non-ok status', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded',
      });

      await expect(provider.sendMessage(defaultOptions)).rejects.toThrow('Error sending message to ALMA');
      expect(provider.conversationStore.storeAssistantResponse).not.toHaveBeenCalled();
    });

    test('throws messageSendError when the response has no text', async () => {
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await expect(provider.sendMessage(defaultOptions)).rejects.toThrow('Error sending message to ALMA');
    });
  });

  describe('generateEvaluationResponse', () => {
    const prompt = 'Evaluate this: ...';

    test('parses a fenced JSON evaluation and uses the evaluation token limit', async () => {
      global.fetch.mockResolvedValueOnce(okResponse('```json\n{"score": 9, "evaluation": "Great work"}\n```'));

      const response = await provider.generateEvaluationResponse(prompt);

      expect(response).toEqual({ score: 9, evaluation: 'Great work' });
      const { body } = lastRequest();
      expect(body.max_tokens).toBe(provider.evaluationMaxTokens);
      expect(body.messages.at(-1)).toEqual({ role: 'user', content: prompt });
    });

    test('throws evaluationError when JSON parsing fails', async () => {
      global.fetch.mockResolvedValueOnce(okResponse('This is not JSON'));

      await expect(provider.generateEvaluationResponse(prompt)).rejects.toThrow(
        'Error evaluating the solution with ALMA'
      );
    });

    test('throws evaluationError on fetch failure', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Network disconnected'));

      await expect(provider.generateEvaluationResponse(prompt)).rejects.toThrow(
        'Error evaluating the solution with ALMA'
      );
    });
  });

  describe('sanitizeJsonResponse helper', () => {
    test('removes generic markdown fences', () => {
      expect(provider.sanitizeJsonResponse('```\n{"test": true}\n```')).toBe('{"test": true}');
    });

    test('removes json markdown fences', () => {
      expect(provider.sanitizeJsonResponse('```json\n{"test": true}\n```')).toBe('{"test": true}');
    });

    test('handles JSON without fences', () => {
      expect(provider.sanitizeJsonResponse('{"test": true}')).toBe('{"test": true}');
    });

    test('trims surrounding whitespace', () => {
      expect(provider.sanitizeJsonResponse('   \n```json\n{"test": true}\n```  \n ')).toBe('{"test": true}');
    });
  });
});
