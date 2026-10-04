require('dotenv').config();
const BaseModel = require('./baseModel');
const Errors = require('../../utils/errors');
const ProviderState = require('../providerState');
const { ConversationStore } = require('../conversationStore');
const ApiKeyProvider = require('../constants');

const DEFAULT_BASE_URL = 'https://alma.us.es/api/models/llama-3.1-8b-instruct/v1';
const DEFAULT_MODEL = 'meta-llama/Llama-3.1-8B-Instruct';
const STOP_TOKENS = ['<|eot_id|>', '<|end_of_text|>', '<|im_end|>'];

function readPositiveInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNumber(name, fallback) {
  const parsed = Number.parseFloat(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Model provider for ALMA (alma.us.es).
 *
 * ALMA serves each model behind its own OpenAI-compatible base URL,
 * https://alma.us.es/api/models/{slug}/v1, and authenticates with the
 * `apikey` header. The API key (and the base URL, when the key defines one)
 * comes from the LEIA API key resolved by the modelManager; ALMA_BASE_URL is
 * only the fallback. ALMA is stateless, so the conversation history lives in
 * Redis through ConversationStore, like the Ollama provider.
 */
class AlmaProvider extends BaseModel {
  constructor() {
    super();
    this.name = 'alma';
    this.apiKeyProvider = ApiKeyProvider.ALMA;
    // Model id sent in the request body. vLLM answers to the raw Hugging Face
    // repo id, which is not the URL slug of the base URL.
    this.model = process.env.ALMA_MODEL || DEFAULT_MODEL;
    this.baseUrl = (process.env.ALMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.maxTokens = readPositiveInt('ALMA_MAX_TOKENS', 1024);
    // Evaluations return Markdown inside JSON, which a short limit truncates.
    this.evaluationMaxTokens = readPositiveInt('ALMA_EVALUATION_MAX_TOKENS', 2048);
    this.temperature = readNumber('ALMA_TEMPERATURE', 0.7);
    this.conversationStore = new ConversationStore({ providerName: 'alma' });
  }

  // Required by BaseModel

  /**
   * ALMA is called with fetch, so the "client" is just its connection data.
   * @param {string} apiKey
   * @returns {{ apiKey: string, baseUrl: string }}
   */
  createClient(apiKey) {
    return { apiKey, baseUrl: this.baseUrl };
  }

  /**
   * Sends a message to the ALMA model using the Redis-backed history.
   * @param {Object} options
   * @param {string} options.sessionId - Session ID (ConversationStore key)
   * @param {string} options.message - User message
   * @param {Object} options.sessionData - Session data from Redis
   * @returns {Promise<{ message: string, sessionData: Object }>}
   */
  async sendMessage(options) {
    const { sessionId, message, sessionData } = options;

    if (!sessionId) {
      throw Errors.alma.missingSessionId();
    }

    const state = new ProviderState(sessionData);
    const systemInstruction = state.getSystemInstruction();

    try {
      const conversationMessages = await this.conversationStore.buildConversationForRequest(
        sessionId,
        systemInstruction,
        message
      );

      const responseMessage = await this.createChatCompletion(conversationMessages, {
        maxTokens: this.maxTokens,
      });

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
      throw Errors.alma.messageSendError(error);
    }
  }

  /**
   * Calls ALMA and returns the structured evaluation.
   * Called by BaseModel.evaluateSolution.
   * @param {string} prompt - Already built evaluation prompt
   * @returns {Promise<{ score: number, evaluation: string }>}
   */
  async generateEvaluationResponse(prompt) {
    try {
      const responseMessage = await this.createChatCompletion(
        [
          {
            role: 'system',
            content:
              'You are an expert evaluator. Your task is to evaluate solutions to problems and provide detailed feedback. Respond only with valid JSON.',
          },
          { role: 'user', content: prompt },
        ],
        { maxTokens: this.evaluationMaxTokens }
      );

      return JSON.parse(this.sanitizeJsonResponse(responseMessage));
    } catch (error) {
      throw Errors.alma.evaluationError(error);
    }
  }

  // Helper methods

  /**
   * POSTs to {baseUrl}/chat/completions and returns the trimmed reply.
   * @param {Array<{ role: string, content: string }>} messages
   * @param {{ maxTokens: number }} options
   * @returns {Promise<string>}
   */
  async createChatCompletion(messages, { maxTokens }) {
    const apiKey = this.ensureApiKey();

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: apiKey,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: maxTokens,
        temperature: this.temperature,
        top_p: 1,
        stop: STOP_TOKENS,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`ALMA request failed (${response.status}): ${errorBody}`);
    }

    const responseData = await response.json();
    const content = responseData?.choices?.[0]?.message?.content;

    if (typeof content !== 'string' || !content.trim()) {
      throw Errors.alma.noTextContent();
    }

    return content.trim();
  }

  /**
   * Strips Markdown code fences (```json ... ```) before JSON.parse.
   * @param {string} responseText
   * @returns {string}
   */
  sanitizeJsonResponse(responseText) {
    const trimmedResponse = responseText.trim();
    const fencedMatch = trimmedResponse.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

    return fencedMatch ? fencedMatch[1].trim() : trimmedResponse;
  }
}

module.exports = AlmaProvider;
