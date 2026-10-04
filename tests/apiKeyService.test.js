import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

// El Runner es CommonJS. Cargamos el SUT y sus dependencias con el require nativo (misma
// caché de módulos que usa el Runner) y sustituimos en caliente los métodos del cliente de
// Redis y de axios, ambos singletons de módulo compartidos con el SUT.
const require = createRequire(import.meta.url);
const axios = require('axios');
const { redisClient } = require('../config/redis');
const apiKeyService = require('../services/apiKeyService');

const original = {
  axiosPost: axios.post,
  redisSet: redisClient.set,
  redisGet: redisClient.get,
};

beforeEach(() => {
  axios.post = vi.fn();
  redisClient.set = vi.fn();
  redisClient.get = vi.fn();
  process.env.VITE_AUTH_SERVICE_BACKEND = 'http://auth-service';
  process.env.INTERN_TOKEN = 'intern-secret';
});

afterEach(() => {
  axios.post = original.axiosPost;
  redisClient.set = original.redisSet;
  redisClient.get = original.redisGet;
});


describe('getApiKeyData — resolución interna protegida', () => {
  test('solicita la clave a leia-auth con el token de servicio y devuelve su valor', async () => {
    axios.post.mockResolvedValue({ data: { keyValue: 'sk-resuelta' } });

    const result = await apiKeyService.getApiKeyData('openai', 'key1', 'userA');

    expect(result).toEqual({ keyValue: 'sk-resuelta' });

    const [url, payload, config] = axios.post.mock.calls[0];
    expect(url).toBe('http://auth-service/api/v1/apikeys/get-value');
    expect(payload).toEqual({ provider: 'openai', apiKeyId: 'key1', apiKeyRequesterId: 'userA' });
    // El secreto solo se resuelve mediante el token interno de servicio.
    expect(config.headers['x-intern-token']).toBe('intern-secret');
  });

  test('incluye la baseUrl cuando leia-auth la devuelve', async () => {
    axios.post.mockResolvedValue({ data: { keyValue: 'sk-x', baseUrl: 'http://localhost:11434' } });

    const result = await apiKeyService.getApiKeyData('ollama', 'key2', 'userB');

    expect(result).toEqual({ keyValue: 'sk-x', baseUrl: 'http://localhost:11434' });
  });

  test('rechaza con 400 si faltan parámetros para resolver la clave', async () => {
    await expect(apiKeyService.getApiKeyData('openai', null, 'userA')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('falla de forma inmediata (fail-fast) si la respuesta no contiene la clave', async () => {
    axios.post.mockResolvedValue({ data: {} });

    await expect(apiKeyService.getApiKeyData('openai', 'key1', 'userA')).rejects.toThrow(
      /Failed to resolve apiKeyId/
    );
  });
});

describe('Marca de revocación en Redis', () => {
  test('revokeApiKey registra la marca temporal de revocación bajo la clave esperada', () => {
    apiKeyService.revokeApiKey('key1');

    expect(redisClient.set).toHaveBeenCalledTimes(1);
    const [redisKey, value] = redisClient.set.mock.calls[0];
    expect(redisKey).toBe('apiKey:key1:revoked');
    // El valor almacenado es una marca temporal válida.
    expect(Number.isNaN(new Date(value).getTime())).toBe(false);
  });

  test('getApiKeyRevokedAt devuelve la fecha de revocación cuando existe', async () => {
    const iso = new Date('2026-05-01T10:00:00.000Z').toISOString();
    redisClient.get.mockResolvedValue(iso);

    const result = await apiKeyService.getApiKeyRevokedAt('key1');

    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe(iso);
  });

  test('getApiKeyRevokedAt devuelve null si la clave no está revocada', async () => {
    redisClient.get.mockResolvedValue(null);

    await expect(apiKeyService.getApiKeyRevokedAt('key1')).resolves.toBeNull();
  });

  test('getApiKeyRevokedAt devuelve null ante una marca temporal corrupta', async () => {
    redisClient.get.mockResolvedValue('no-es-una-fecha');

    await expect(apiKeyService.getApiKeyRevokedAt('key1')).resolves.toBeNull();
  });
});
