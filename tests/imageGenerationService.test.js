import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const apiKeyService = require('../services/apiKeyService');
const imageGenerationService = require('../services/imageGenerationService');

const originalGetApiKeyData = apiKeyService.getApiKeyData;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;

beforeEach(() => {
  apiKeyService.getApiKeyData = vi.fn();
});

afterEach(() => {
  apiKeyService.getApiKeyData = originalGetApiKeyData;
  process.env.GEMINI_API_KEY = originalGeminiApiKey;
});

describe('Gemini image client BYOK resolution', () => {
  test('resolves image generation keys through auth using the Gemini provider', async () => {
    apiKeyService.getApiKeyData.mockResolvedValue({ keyValue: 'AIzaSy-user-key' });

    const client = await imageGenerationService.getGeminiClient({
      apiKeyId: 'key1',
      apiKeyRequesterId: 'user1',
    });

    expect(client).toBeTruthy();
    expect(apiKeyService.getApiKeyData).toHaveBeenCalledWith('gemini', 'key1', 'user1');
  });

  test('does not fall back to GEMINI_API_KEY when request key data is missing', async () => {
    process.env.GEMINI_API_KEY = 'AIzaSy-env-key';

    await expect(imageGenerationService.getGeminiClient()).rejects.toMatchObject({
      code: 'invalid_api_key',
      statusCode: 400,
    });
    expect(apiKeyService.getApiKeyData).not.toHaveBeenCalled();
  });
});
