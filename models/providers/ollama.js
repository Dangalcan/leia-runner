require('dotenv').config();
const BaseModel = require('./baseModel');
const Errors = require('../../utils/errors');
const ProviderState = require('../providerState');
const { ConversationStore } = require('../conversationStore');
const ApiKeyProvider = require('../constants');

class OllamaProvider extends BaseModel {
  constructor() {
    super();
    this.name = 'ollama';
    this.model = process.env.OLLAMA_MODEL || 'llama3.1:8b';
    this.apiKeyProvider = ApiKeyProvider.OLLAMA;
    this.evaluationModel = process.env.OLLAMA_EVALUATION_MODEL || this.model;
    this.baseUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
    this.conversationStore = new ConversationStore({
      providerName: 'ollama',
      defaultMaxMessages: 60
    });
  }

  // Requerido por BaseModel
  createClient() {
    return {
      baseUrl: this.baseUrl,
      apiKey: process.env.OLLAMA_API_KEY || '',
    };
  }

  async sendMessage(options) {
    const { sessionId, message, sessionData } = options;

    if (!sessionId) {
      throw Errors.ollama.missingSessionId();
    }

    const state = new ProviderState(sessionData);
    const systemInstruction = state.getSystemInstruction();

    try {
      const conversationMessages = await this.conversationStore.buildConversationForRequest(
        sessionId,
        systemInstruction,
        message
      );

      const chatResponse = await this.createChatCompletion({
        model: this.model,
        messages: conversationMessages,
      });

      const responseMessage = this.extractAssistantMessage(chatResponse);

      if (!responseMessage) {
        throw Errors.ollama.noTextContent();
      }

      await this.conversationStore.storeAssistantResponse(sessionId, responseMessage);

      state.update({
        conversationKey: this.conversationStore.getConversationKey(sessionId),
        model: this.model,
      });

      return {
        message: responseMessage,
        sessionData: state.buildSessionData(sessionId),
      };
    } catch (error) {
      throw Errors.ollama.messageSendError(error);
    }
  }

  /**
   * Realiza la llamada al API de Ollama y devuelve la evaluación estructurada.
   * Invocado por BaseModel.evaluateSolution.
   * @param {string} prompt - Prompt de evaluación ya construido
   * @returns {Promise<Object>} - { score, evaluation }
   */
  async generateEvaluationResponse(prompt) {
    try {
      const response = await this.createChatCompletion({
        model: this.evaluationModel,
        messages: [
          {
            role: 'system',
            content:
              'You are an expert evaluator. Your task is to evaluate solutions to problems and provide detailed feedback.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        format: this.getEvaluationResponseFormat(),
      });

      const responseMessage = this.extractAssistantMessage(response);

      if (!responseMessage) {
        throw Errors.ollama.noEvaluationContent();
      }

      return JSON.parse(this.sanitizeJsonResponse(responseMessage));
    } catch (error) {
      throw Errors.ollama.evaluationError(error);
    }
  }

  // Métodos auxiliares

  async createChatCompletion({ model, messages, format }) {
    const headers = {
      'Content-Type': 'application/json',
    };

    const requestBody = {
      model,
      messages,
      stream: false,
    };

    if (format) {
      requestBody.format = format;
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${errorBody}`);
    }

    const responseData = await response.json();

    if (responseData?.error) {
      throw new Error(responseData.error);
    }

    return responseData;
  }

  extractAssistantMessage(response) {
    if (!response || typeof response !== 'object') {
      return '';
    }

    const content = response.message && typeof response.message.content === 'string'
      ? response.message.content.trim()
      : '';

    return content;
  }

  getEvaluationResponseFormat() {
    return {
      type: 'object',
      properties: {
        score: {
          type: 'number',
          description: 'Score between 0 and 10',
        },
        evaluation: {
          type: 'string',
          description: 'Detailed evaluation in Markdown format',
        },
      },
      required: ['score', 'evaluation'],
    };
  }

  sanitizeJsonResponse(responseText) {
    const trimmedResponse = responseText.trim();
    const fencedMatch = trimmedResponse.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

    return fencedMatch ? fencedMatch[1].trim() : trimmedResponse;
  }
}

module.exports = OllamaProvider;
