import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const generation = require('../services/structuredGenerationService');
const manager = require('../models/modelManager');
const keys = require('../services/apiKeyService');
const originalModules = manager.providerModules;
const originalKeyResolver = keys.getApiKeyData;
const originalOpenAI = generation.generateWithOpenAI;
const originalGemini = generation.generateWithGemini;
const config = { provider: 'user-openai', apiKeyId: 'key-id', apiKeyRequesterId: 'user-id', modelName: 'configured-model' };
beforeEach(() => {
  manager.providerModules = new Map([
    ['user-openai', class { apiKeyProvider = 'openai'; }],
    ['user-gemini', class { apiKeyProvider = 'gemini'; }],
  ]);
  keys.getApiKeyData = vi.fn().mockResolvedValue({ keyValue: 'user-secret', baseUrl: 'https://user-proxy.example/v1' });
});
afterEach(() => {
  manager.providerModules = originalModules;
  keys.getApiKeyData = originalKeyResolver;
  generation.generateWithOpenAI = originalOpenAI;
  generation.generateWithGemini = originalGemini;
  vi.restoreAllMocks();
});
describe('structured generation BYOK', () => {
  test('uses user OpenAI credentials, configured model and custom base URL in isolated clients', async () => {
    vi.spyOn(generation, 'resolveProvider').mockImplementation(() => { throw new Error('Environment provider must not be used'); });
    generation.generateWithOpenAI = vi.fn().mockResolvedValue({ satisfied: false });
    await generation.generateObject({ runnerConfiguration: config });
    await generation.generateObject({ runnerConfiguration: { ...config, apiKeyId: 'other-user-key' } });
    expect(keys.getApiKeyData).toHaveBeenCalledWith('openai', 'key-id', 'user-id');
    const first = generation.generateWithOpenAI.mock.calls[0][0];
    const second = generation.generateWithOpenAI.mock.calls[1][0];
    expect(first.openaiModel).toBe('configured-model');
    expect(first.client.apiKey).toBe('user-secret');
    expect(first.client.baseURL).toBe('https://user-proxy.example/v1');
    expect(first.client).not.toBe(second.client);
  });
  test('selects Gemini from the user provider rather than AI_PROVIDER', async () => {
    vi.spyOn(generation, 'resolveProvider').mockImplementation(() => { throw new Error('Environment provider must not be used'); });
    keys.getApiKeyData.mockResolvedValue({ keyValue: 'user-gemini-secret' });
    generation.generateWithGemini = vi.fn().mockResolvedValue({ satisfied: true });
    await generation.generateObject({ runnerConfiguration: { ...config, provider: 'user-gemini' } });
    expect(keys.getApiKeyData).toHaveBeenCalledWith('gemini', 'key-id', 'user-id');
    expect(generation.generateWithGemini.mock.calls[0][0]).toMatchObject({ geminiModel: 'configured-model', client: expect.any(Object) });
  });
  test('does not fall back to environment credentials on missing or unresolvable user credentials', async () => {
    const fallback = vi.spyOn(generation, 'getOpenAIClient');
    await expect(generation.generateObject({ runnerConfiguration: {} })).rejects.toThrow('BYOK credentials');
    keys.getApiKeyData.mockRejectedValue(new Error('User key not authorized'));
    await expect(generation.generateObject({ runnerConfiguration: config })).rejects.toThrow('User key not authorized');
    expect(fallback).not.toHaveBeenCalled();
  });
  test('the OpenAI execution path uses the supplied client', async () => {
    const client = { responses: { parse: vi.fn().mockResolvedValue({ output_parsed: { satisfied: true } }) } };
    const fallback = vi.spyOn(generation, 'getOpenAIClient').mockImplementation(() => { throw new Error('Environment key must not be used'); });
    const z = require('zod');
    const result = await generation.generateWithOpenAI({ client, openaiModel: 'configured-model', zodSchema: z.object({ satisfied: z.boolean() }), schemaName: 'decision' });
    expect(result).toEqual({ satisfied: true });
    expect(client.responses.parse).toHaveBeenCalledWith(expect.objectContaining({ model: 'configured-model' }));
    expect(fallback).not.toHaveBeenCalled();
  });
});
