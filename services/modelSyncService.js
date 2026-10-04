const { redisClient } = require('../config/redis');
const modelManager = require('../models/modelManager');

class ModelSyncService {
  constructor() {
    this.keyPrefix = 'models:';
    this.isSyncing = false;
  }

  /**
   * Synchronizes available models in Redis
   * @param {boolean} force - If true, forces synchronization even if already in progress
   * @returns {Promise<void>}
   */
  async syncModels(force = false) {
    if (this.isSyncing && !force) {
      console.log('Model synchronization already in progress');
      return;
    }

    try {
      this.isSyncing = true;
      const models = modelManager.getAvailableModels();
      const defaultModel = modelManager.getDefaultModel();
      const apiKeyProvidersMap = modelManager.getApiKeyProvidersByModel();
      const providerProviderModuleMap = modelManager.getProviderProviderModuleMap();

      // Save models in Redis
      await redisClient.set(
        `${this.keyPrefix}available`,
        JSON.stringify(models)
      );

      // Save default model
      await redisClient.set(
        `${this.keyPrefix}default`,
        defaultModel
      );

      await redisClient.set(
        `${this.keyPrefix}apiKeyProviders`,
        JSON.stringify(apiKeyProvidersMap)
      );

      await redisClient.set(
        `${this.keyPrefix}providerProviderModuleMap`,
        JSON.stringify(providerProviderModuleMap)
      );

      console.log('Models synchronized successfully in Redis');
    } catch (error) {
      console.error('Error synchronizing models in Redis:', error);
      throw error;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Gets available models from Redis
   * @returns {Promise<Object>} - Object with available models and default model
   */
  async getModelsFromRedis() {
    try {
      const [availableModels, defaultModel, apiKeyProviders, providerProviderModuleMap] = await Promise.all([
        redisClient.get(`${this.keyPrefix}available`),
        redisClient.get(`${this.keyPrefix}default`),
        redisClient.get(`${this.keyPrefix}apiKeyProviders`),
        redisClient.get(`${this.keyPrefix}providerProviderModuleMap`)
      ]);

      return {
        models: JSON.parse(availableModels || '[]'),
        default: defaultModel || modelManager.getDefaultModel(),
        apiKeyProviders: JSON.parse(apiKeyProviders || '{}'),
        providerProviderModuleMap: JSON.parse(providerProviderModuleMap || '{}')
      };
    } catch (error) {
      console.error('Error getting models from Redis:', error);
      throw error;
    }
  }

  /**
   * Forces model synchronization
   * @returns {Promise<void>}
   */
  async forceSync() {
    return this.syncModels(true);
  }
}

const modelSyncService = new ModelSyncService();
module.exports = modelSyncService;