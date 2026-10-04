const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const modelSyncService = require('../services/modelSyncService');
const apiKeyService = require('../services/apiKeyService');

class ModelManager {
  constructor() {
    this.modelDir = path.join(__dirname, 'providers');
    this.defaultModel = process.env.DEFAULT_MODEL || 'openai';
    // Almacena los constructores de los providers, antes se llamaba models
    this.providerModules = new Map();
    // Almacena los proveedores de API Key asociados a cada providerModule
    this.modelApiKeyProviders = new Map();
    // Mapa para relacionar providerModules con sus proveedores de API Key
    this.providerProviderModuleMap = new Map();
    // Cache para instancias de modelos, claveada por un token que puede ser provider:modelName:apiKeyId o similar
    this.instancePromiseCache = new Map();
  }

  async initialize() {
    try {
      // Crear directorio de proveedores si no existe
      try {
        await fs.mkdir(this.modelDir, { recursive: true });
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }

      await this.loadModels();

      if (!this.providerModules.has(this.defaultModel)) {
        const firstModel = Array.from(this.providerModules.keys())[0];
        if (firstModel) {
          this.defaultModel = firstModel;
          console.warn(
            `Modelo por defecto '${process.env.DEFAULT_MODEL}' no está disponible. Usando '${this.defaultModel}'.`
          );
        } else {
          console.warn('No hay modelos disponibles cargados.');
        }
      }
      console.log(`Modelo manager inicializado exitosamente. Modelo por defecto: ${this.defaultModel}`);
    } catch (error) {
      console.error('Error inicializando el manager de modelos:', error);
      throw error;
    }
  }

  async loadModels() {
    try {
      this.providerModules.clear();
      const files = await fs.readdir(this.modelDir);
      const providerFiles = files.filter((file) => file.endsWith('.js') && file !== 'baseModel.js');

      for (const file of providerFiles) {
        const providerModuleName = path.basename(file, '.js');
        const providerModulePath = path.join(this.modelDir, file);

        try {
          // Importar el modelo
          const ProviderModule = require(providerModulePath);
          const providerInstance = new ProviderModule();
          this.providerModules.set(providerModuleName, ProviderModule);
          this.setApiKeyProviders(providerInstance);
          this.setProviderModulesProvidersMap(providerModuleName, providerInstance.apiKeyProvider);
          console.log(`Modelo '${providerModuleName}' cargado exitosamente`);
        } catch (error) {
          console.error(`Error cargando el modelo '${providerModuleName}':`, error);
        }
      }
    } catch (error) {
      console.error('Error cargando modelos:', error);
      throw error;
    }
  }

  setProviderModulesProvidersMap(providerModuleName, apiKeyProvider) {
    if (!this.providerProviderModuleMap.has(apiKeyProvider)) {
      this.providerProviderModuleMap.set(apiKeyProvider, providerModuleName);
    }
  }
  /**
   * Recibe una instancia del modelo y obtiene su proveedor de ApiKey para actualizar el mapa del modelManager
   * @param {string} modelName - Nombre del modelo a registrar
   * @param {ProviderObject} modelModule
   */
  setApiKeyProviders(modelInstance) {
    const model = modelInstance.model || 'default';
    try {
      if (modelInstance && modelInstance.apiKeyProvider) {
        const apiKeyProvider = modelInstance.apiKeyProvider;
        if (this.modelApiKeyProviders.has(apiKeyProvider)) {
          this.modelApiKeyProviders.set(apiKeyProvider, [...this.modelApiKeyProviders.get(apiKeyProvider), model]);
        } else {
          this.modelApiKeyProviders.set(apiKeyProvider, [model]);
        }
      } else {
        console.warn(`El modelo '${model}' no tiene definido un apiKeyProvider.`);
      }
    } catch (error) {
      console.error(`Error estableciendo el proveedor de API key para el modelo '${model}':`, error);
    }
  }
  //getProviderInstance
  async getModel(provider = 'default', apiKeyId, apiKeyRequesterId, sessionModelToken) {
    // Si se solicita el modelo por defecto, usar el configurado
    const targetProvider = provider === 'default' ? this.defaultModel : provider;
    if (!this.providerModules.has(targetProvider)) {
      return Promise.reject(new Error(`Modelo '${targetProvider}' no encontrado`));
    }
    if (this.instancePromiseCache.has(sessionModelToken)) {
      const cached = this.instancePromiseCache.get(sessionModelToken);
      const isRevoked = await this.checkRevocationStatus(cached.createdAt, apiKeyId, sessionModelToken);
      if (!isRevoked) {
        return cached.promise;
      }
    }

    if (this.instancePromiseCache.has(sessionModelToken)) {
      return this.instancePromiseCache.get(sessionModelToken).promise;
    }
    const instancePromise = this.createModelInstance(targetProvider, apiKeyId, apiKeyRequesterId, sessionModelToken);
    this.instancePromiseCache.set(sessionModelToken, {
      promise: instancePromise,
      createdAt: new Date(),
    });
    return instancePromise;
  }
  async checkRevocationStatus(createdAt, apiKeyId, sessionModelToken) {
    const revokedAtApiKey = await apiKeyService.getApiKeyRevokedAt(apiKeyId);
    if (revokedAtApiKey && revokedAtApiKey > createdAt) {
      this.instancePromiseCache.delete(sessionModelToken);
      return true;
    }
    return false;
  }
  async createModelInstance(targetProvider, apiKeyId, apiKeyRequesterId, sessionModelToken) {

    try {
      const ModelClass = this.providerModules.get(targetProvider);
      const modelInstance = new ModelClass();

      if (!modelInstance.apiKeyProvider) {
      throw new Error(`El modelo '${targetProvider}' no tiene un apiKeyProvider definido, no se puede configurar la API key.`);
      }
      const {keyValue, baseUrl} = await apiKeyService.getApiKeyData(modelInstance.apiKeyProvider, apiKeyId, apiKeyRequesterId);
      modelInstance.setApiKey(keyValue);
      if (baseUrl) {
        modelInstance.setBaseURL(baseUrl);
      }
      return modelInstance;
    }catch (error) {
      console.error(`Error creando instancia del modelo '${targetProvider}':`, error);
      this.instancePromiseCache.delete(sessionModelToken);
      throw error;
    }
  }
  // registerProviderModule
  async registerModel(modelName, modelCode) {
    try {
      // Guardar el modelo en el sistema de archivos
      const modelPath = path.join(this.modelDir, `${modelName}.js`);
      await fs.writeFile(modelPath, modelCode);

      // Recargar y probar el modelo
      delete require.cache[require.resolve(modelPath)];
      const modelModule = require(modelPath);

      if (typeof modelModule.createSession !== 'function' || typeof modelModule.sendMessage !== 'function') {
        return {
          success: false,
          errors: ['El modelo debe implementar createSession y sendMessage'],
        };
      }

      this.providerModules.set(modelName, modelModule);
      await this.notifyModelChanges();
      return { success: true };
    } catch (error) {
      console.error(`Error registrando el modelo '${modelName}':`, error);
      return {
        success: false,
        errors: [error.message],
      };
    }
  }

  async initializeProviderModules() {
    await this.initialize();
  }

  getAvailableModels() {
    return Array.from(this.providerModules.keys());
  }

  getApiKeyProvidersByModel() {
    return Object.fromEntries(this.modelApiKeyProviders);
  }

  getProviderProviderModuleMap() {
    return Object.fromEntries(this.providerProviderModuleMap);
  }
  getDefaultModel() {
    return this.defaultModel;
  }

  setDefaultModel(name) {
    if (!this.providerModules.has(name)) {
      throw new Error(`Model ${name} not found`);
    }
    this.defaultModel = name;
    return this.notifyModelChanges();
  }

  async notifyModelChanges() {
    try {
      await modelSyncService.syncModels();
    } catch (error) {
      console.error('Error notifying model changes:', error);
    }
  }
}

// Singleton pattern
const modelManager = new ModelManager();

module.exports = modelManager;