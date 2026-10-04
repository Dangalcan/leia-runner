const axios = require('axios');
const { redisClient } = require('../config/redis');

class ApiKeyService {
      constructor() {
    this.keyPrefix = 'apiKey:';
      }


  async getApiKeyData(apiKeyProvider, apiKeyId, apiKeyRequesterId) {

    if (apiKeyProvider && apiKeyId && apiKeyRequesterId) {
      try {
        const authBase = process.env.VITE_AUTH_SERVICE_BACKEND;
        const url = `${authBase}/api/v1/apikeys/get-value`;
        const payload = {
          provider: apiKeyProvider,
          apiKeyId: apiKeyId,
          apiKeyRequesterId: apiKeyRequesterId
        };
        const config = {
          headers: {
            'x-intern-token': process.env.INTERN_TOKEN,
          }
        };
        const resp = await axios.post(url, payload, config);
        if (resp && resp.data && resp.data.keyValue) {
          if (resp.data.baseUrl) {
            return { keyValue: resp.data.keyValue, baseUrl: resp.data.baseUrl };
          }
          return { keyValue: resp.data.keyValue };
        } else {
          throw new Error('Designer returned no apiKeyInfo for apiKeyId');
        }
      } catch (err) {
        // Fail fast: resolving the key is critical before starting the runner session
        err.message = `Failed to resolve apiKeyId from Designer: ${err.message}`;
        throw err;
      }
    } else {
      let error = new Error('Bad Request', 'No apiKeyId or apiKeyRequesterId provided in runnerConfiguration');
      error.statusCode = 400;
      throw error;
    }
  }

  revokeApiKey(apiKeyId) {
    const revoKedDate = new Date().toISOString();
    redisClient.set(`${this.keyPrefix}${apiKeyId}:revoked`, revoKedDate);
  }

  async getApiKeyRevokedAt(apiKeyId) {
    const revokedAt = await redisClient.get(`${this.keyPrefix}${apiKeyId}:revoked`);
    if (!revokedAt) {
      return null;
    }

    const revokedDate = new Date(revokedAt);
    if (Number.isNaN(revokedDate.getTime())) {
      return null;
    }

    return revokedDate;
  }

}

module.exports = new ApiKeyService();
