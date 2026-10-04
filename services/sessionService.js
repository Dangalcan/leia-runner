const { redisClient } = require('../config/redis');
const modelManager = require('../models/modelManager');

class SessionService {
  constructor() {
    this.keyPrefix = 'session:';
    this.leiaMetaPrefix = 'leia:meta:';
  }

  serializeSessionData(sessionData) {
    const redisSessionData = {};

    for (const [key, value] of Object.entries(sessionData)) {
      if (value === null || value === undefined) {
        redisSessionData[key] = '';
      } else if (typeof value === 'object') {
        redisSessionData[key] = JSON.stringify(value);
      } else {
        redisSessionData[key] = String(value);
      }
    }

    return redisSessionData;
  }

  deserializeSessionData(sessionData) {
    if (!sessionData || Object.keys(sessionData).length === 0) {
      return null;
    }

    const normalizedSessionData = { ...sessionData };

    if (normalizedSessionData.providerState) {
      try {
        normalizedSessionData.providerState = JSON.parse(normalizedSessionData.providerState);
      } catch (error) {
        console.warn('No se pudo parsear providerState, se usará el valor almacenado:', error.message);
      }
    }

    return normalizedSessionData;
  }

  async updateSession(sessionId, sessionUpdates) {
    const currentSessionData = await this.getSession(sessionId);

    if (!currentSessionData) {
      return null;
    }

    const mergedSessionData = { ...currentSessionData };

    for (const [key, value] of Object.entries(sessionUpdates)) {
      if (value !== undefined) {
        mergedSessionData[key] = value;
      }
    }

    await redisClient.hSet(
      `${this.keyPrefix}${sessionId}`,
      this.serializeSessionData(mergedSessionData)
    );

    return mergedSessionData;
  }

  // Darle caña aqui
  async createSession(sessionId, prompt, modelName, provider, apiKeyId, apiKeyRequesterId) {
    try {
      // Get the model
       //"provider,keyId" //no singleton quiza es mejor modelname:apiKeyId,
       // en vd es lo mismo pq el modelName nos da igual pa eso
       //Ahora msimo se va a hacr con el providerModule pero de cara a usar vrios modelos distintos se podri aplantear tb el modelo
      const sessionModelToken = `${provider}:${modelName}:${apiKeyId}`;
      const model = await modelManager.getModel(provider, apiKeyId, apiKeyRequesterId, sessionModelToken);
      // Create a session with the selected provider
      const sessionDetails = await model.createSession({
        instructions: prompt
      });

      // Save session information in Redis
      const sessionData = {
        sessionId,
        provider: provider,//(provider)
        modelName: modelName,
        apiKeyId: apiKeyId,
        apiKeyRequesterId: apiKeyRequesterId,
        threadId: sessionDetails.threadId ?? '',
        providerState: sessionDetails.providerState ?? '',
        createdAt: Date.now()
      };

      await redisClient.hSet(
        `${this.keyPrefix}${sessionId}`,
        this.serializeSessionData(sessionData)
      );
      return sessionData;
    } catch (error) {
      console.error(`Error creating session ${sessionId}:`, error);
      throw error;
    }
  }

  async getSession(sessionId) {
    try {
      const sessionData = await redisClient.hGetAll(`${this.keyPrefix}${sessionId}`);

      return this.deserializeSessionData(sessionData);
    } catch (error) {
      console.error(`Error getting session ${sessionId}:`, error);
      throw error;
    }
  }

  async deleteSession(sessionId) {
    await redisClient.del([
      `${this.keyPrefix}${sessionId}`,
      `${this.leiaMetaPrefix}${sessionId}`,
    ]);
  }

  async sendMessage(sessionId, message, options = {}) {
    try {
      // Get the session
      const sessionData = await this.getSession(sessionId);

      if (!sessionData) {
        return null; // Return null instead of throwing an error
      }

      // Honor the activity-level gate set at createLeia. Trusted Runner-only
      // sessions, such as the private MultiLEIA coordinator, can explicitly
      // enable their internal tools without exposing them to participants.
      const leiaMeta = await this.getLeiaMeta(sessionId);
      const allowTools =
        options.internalTools === true || leiaMeta?.toolFunctionsEnabled === 'true';

      // Get the model for this session (BYOK: resolved by provider + api key).
      const sessionModelToken = `${sessionData.provider}:${sessionData.modelName}:${sessionData.apiKeyId}`;
      const model = await modelManager.getModel(sessionData.provider, sessionData.apiKeyId, sessionData.apiKeyRequesterId, sessionModelToken);

      // Send the message through the model
      const response = await model.sendMessage({
        sessionId,
        message,
        sessionData,
        allowTools,
        tools: allowTools ? options.tools : undefined,
        toolResults: allowTools ? options.toolResults : undefined,
        internalTools: options.internalTools === true,
        parallelToolCalls: options.parallelToolCalls,
        toolChoice: options.toolChoice,
      });

      if (response?.sessionData) {
        await this.updateSession(sessionId, response.sessionData);
        delete response.sessionData;
      }

      return response;
    } catch (error) {
      console.error(`Error sending message in session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Stores LEIA metadata associated with the session
   * @param {string} sessionId - Session ID
   * @param {Object} metadata - LEIA metadata
   * @returns {Promise<void>}
   */
  async storeLeiaMeta(sessionId, metadata) {
    try {
      // Convertir el objeto metadata a un formato que Redis pueda almacenar
      const redisMetadata = {};

      // Asegurarse de que todos los valores sean strings
      for (const [key, value] of Object.entries(metadata)) {
        redisMetadata[key] = value !== null && value !== undefined ? String(value) : '';
      }

      await redisClient.hSet(
        `${this.leiaMetaPrefix}${sessionId}`,
        redisMetadata
      );
    } catch (error) {
      console.error(`Error storing LEIA metadata for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Gets LEIA metadata associated with the session
   * @param {string} sessionId - Session ID
   * @returns {Promise<Object|null>} - LEIA metadata
   */
  async getLeiaMeta(sessionId) {
    try {
      const metadata = await redisClient.hGetAll(`${this.leiaMetaPrefix}${sessionId}`);

      if (!metadata || Object.keys(metadata).length === 0) {
        return null;
      }

      return metadata;
    } catch (error) {
      console.error(`Error getting LEIA metadata for session ${sessionId}:`, error);
      throw error;
    }
  }
}

const sessionService = new SessionService();
module.exports = sessionService;
