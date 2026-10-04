import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

// El Runner es CommonJS. Cargamos el SUT y sus dependencias con el require nativo (misma
// caché de módulos de Node que usa el propio Runner) para luego sustituir en caliente los
// métodos del singleton apiKeyService. Así el ModelManager y el test comparten la misma
// instancia y controlamos la resolución de claves sin tocar Redis ni la red.
const require = createRequire(import.meta.url);
const apiKeyService = require('../services/apiKeyService');
const modelManager = require('../models/modelManager');

const original = {
  getApiKeyData: apiKeyService.getApiKeyData,
  getApiKeyRevokedAt: apiKeyService.getApiKeyRevokedAt,
};

// Doble de proveedor (subclase de BaseModel) que registra la credencial inyectada.
class FakeProvider {
  constructor() {
    this.apiKeyProvider = 'openai';
    this.apiKey = null;
    this.baseUrl = null;
  }
  setApiKey(key) {
    this.apiKey = key;
  }
  setBaseURL(url) {
    this.baseUrl = url;
  }
}

// El ModelManager es un singleton con estado: lo reseteamos antes de cada test.
beforeEach(() => {
  apiKeyService.getApiKeyData = vi.fn();
  apiKeyService.getApiKeyRevokedAt = vi.fn();
  modelManager.instancePromiseCache.clear();
  modelManager.providerModules.clear();
  modelManager.modelApiKeyProviders.clear();
  modelManager.providerProviderModuleMap.clear();
  modelManager.providerModules.set('openai', FakeProvider);
});

afterEach(() => {
  apiKeyService.getApiKeyData = original.getApiKeyData;
  apiKeyService.getApiKeyRevokedAt = original.getApiKeyRevokedAt;
});

// RNF-04: las peticiones concurrentes al mismo modelo se resuelven con una sola
// inicialización gracias a la caché de promesas (evita el efecto thundering herd).
describe('Caché de promesas y concurrencia (RNF-04)', () => {
  test('k peticiones concurrentes producen una única inicialización subyacente', async () => {
    apiKeyService.getApiKeyRevokedAt.mockResolvedValue(null);
    apiKeyService.getApiKeyData.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { keyValue: 'sk-shared' };
    });

    const token = 'openai:gpt:key1';
    const concurrentCalls = Array.from({ length: 5 }, () =>
      modelManager.getModel('openai', 'key1', 'userA', token)
    );
    const instances = await Promise.all(concurrentCalls);

    // Una sola resolución de la clave pese a las 5 peticiones simultáneas.
    expect(apiKeyService.getApiKeyData).toHaveBeenCalledTimes(1);
    // Todas comparten exactamente la misma instancia cacheada.
    for (const instance of instances) {
      expect(instance).toBe(instances[0]);
    }
    expect(instances[0].apiKey).toBe('sk-shared');
  });

  test('reutiliza la instancia cacheada mientras la clave no se revoque', async () => {
    apiKeyService.getApiKeyData.mockResolvedValue({ keyValue: 'sk-x' });
    apiKeyService.getApiKeyRevokedAt.mockResolvedValue(null);

    const first = await modelManager.getModel('openai', 'key1', 'userA', 'token');
    const second = await modelManager.getModel('openai', 'key1', 'userA', 'token');

    expect(first).toBe(second);
    expect(apiKeyService.getApiKeyData).toHaveBeenCalledTimes(1);
  });
});

describe('Inyección de credenciales sin cruce entre sesiones', () => {
  test('dos sesiones distintas reciben cada una su propia credencial', async () => {
    apiKeyService.getApiKeyRevokedAt.mockResolvedValue(null);
    apiKeyService.getApiKeyData.mockImplementation(async (provider, apiKeyId) => ({
      keyValue: `sk-${apiKeyId}`,
    }));

    const instanceA = await modelManager.getModel('openai', 'keyA', 'userA', 'tokenA');
    const instanceB = await modelManager.getModel('openai', 'keyB', 'userB', 'tokenB');

    expect(instanceA).not.toBe(instanceB);
    expect(instanceA.apiKey).toBe('sk-keyA');
    expect(instanceB.apiKey).toBe('sk-keyB');
  });

  test('inyecta la baseUrl cuando el proveedor la aporta (proveedor local)', async () => {
    apiKeyService.getApiKeyRevokedAt.mockResolvedValue(null);
    apiKeyService.getApiKeyData.mockResolvedValue({ keyValue: 'sk-x', baseUrl: 'http://localhost:11434' });

    const instance = await modelManager.getModel('openai', 'key1', 'userA', 'token-base');

    expect(instance.baseUrl).toBe('http://localhost:11434');
  });

  test('no inyecta baseUrl cuando el proveedor no la aporta', async () => {
    apiKeyService.getApiKeyRevokedAt.mockResolvedValue(null);
    apiKeyService.getApiKeyData.mockResolvedValue({ keyValue: 'sk-x' });

    const instance = await modelManager.getModel('openai', 'key1', 'userA', 'token-nobase');

    expect(instance.baseUrl).toBeNull();
  });

  test('rechaza la petición de un modelo no registrado', async () => {
    await expect(modelManager.getModel('inexistente', 'k', 'u', 'tok')).rejects.toThrow(/no encontrado/);
  });
});


describe('Robustez de la creación de instancias', () => {
  class NoProviderModel {
    constructor() {
      this.apiKeyProvider = null;
    }
    setApiKey() {}
    setBaseURL() {}
  }

  test('rechaza si el modelo no define un apiKeyProvider', async () => {
    modelManager.providerModules.set('noprov', NoProviderModel);
    apiKeyService.getApiKeyRevokedAt.mockResolvedValue(null);

    await expect(modelManager.getModel('noprov', 'k', 'u', 'tok-noprov')).rejects.toThrow(/apiKeyProvider/);
  });

  test('propaga el error y purga la caché si la resolución de la clave falla', async () => {
    apiKeyService.getApiKeyRevokedAt.mockResolvedValue(null);
    apiKeyService.getApiKeyData
      .mockRejectedValueOnce(new Error('leia-auth no disponible'))
      .mockResolvedValueOnce({ keyValue: 'sk-recuperada' });

    await expect(modelManager.getModel('openai', 'key1', 'userA', 'tok-retry')).rejects.toThrow(
      /leia-auth no disponible/
    );
    // Al haberse purgado la caché, una nueva petición vuelve a intentar la resolución.
    const retry = await modelManager.getModel('openai', 'key1', 'userA', 'tok-retry');
    expect(retry.apiKey).toBe('sk-recuperada');
    expect(apiKeyService.getApiKeyData).toHaveBeenCalledTimes(2);
  });
});


describe('Invalidación perezosa de la instancia cacheada', () => {
  test('re-crea la instancia cuando la clave se revoca después de cachearse', async () => {
    apiKeyService.getApiKeyData
      .mockResolvedValueOnce({ keyValue: 'sk-old' })
      .mockResolvedValueOnce({ keyValue: 'sk-new' });
    apiKeyService.getApiKeyRevokedAt.mockResolvedValue(null);

    const token = 'openai:gpt:key1';
    const first = await modelManager.getModel('openai', 'key1', 'userA', token);
    expect(first.apiKey).toBe('sk-old');

    // La clave se actualiza/revoca DESPUÉS de haberse creado la instancia.
    apiKeyService.getApiKeyRevokedAt.mockResolvedValue(new Date(Date.now() + 60_000));

    const second = await modelManager.getModel('openai', 'key1', 'userA', token);

    expect(apiKeyService.getApiKeyData).toHaveBeenCalledTimes(2);
    expect(second.apiKey).toBe('sk-new');
    expect(second).not.toBe(first);
  });

  test('no re-crea la instancia si la revocación es anterior a su creación', async () => {
    apiKeyService.getApiKeyData.mockResolvedValue({ keyValue: 'sk-x' });
    apiKeyService.getApiKeyRevokedAt.mockResolvedValue(new Date(Date.now() - 60_000));

    const token = 'openai:gpt:key1';
    const first = await modelManager.getModel('openai', 'key1', 'userA', token);
    const second = await modelManager.getModel('openai', 'key1', 'userA', token);

    expect(first).toBe(second);
    expect(apiKeyService.getApiKeyData).toHaveBeenCalledTimes(1);
  });
});

describe('Mapeo proveedor de clave - modelo', () => {
  test('getApiKeyProvidersByModel agrupa los modelos por proveedor de clave', () => {
    modelManager.setApiKeyProviders({ apiKeyProvider: 'openai', model: 'gpt-4.1' });
    modelManager.setApiKeyProviders({ apiKeyProvider: 'openai', model: 'gpt-4o' });
    modelManager.setApiKeyProviders({ apiKeyProvider: 'gemini', model: 'gemini-flash' });

    const map = modelManager.getApiKeyProvidersByModel();

    expect(map.openai).toEqual(['gpt-4.1', 'gpt-4o']);
    expect(map.gemini).toEqual(['gemini-flash']);
  });

  test('relaciona cada proveedor de clave con su módulo de proveedor', () => {
    modelManager.setProviderModulesProvidersMap('openai-responses', 'openai');

    expect(modelManager.getProviderProviderModuleMap().openai).toBe('openai-responses');
  });

  test('ignora un modelo que no declara apiKeyProvider al construir el mapa', () => {
    modelManager.setApiKeyProviders({ model: 'sin-proveedor' });

    expect(modelManager.getApiKeyProvidersByModel()).toEqual({});
  });
});
