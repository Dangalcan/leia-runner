require('dotenv').config();
const BaseModel = require('./baseModel');
const Errors = require('../../utils/errors');
const ProviderState = require('../providerState');
const { GoogleGenAI } = require('@google/genai');
const ApiKeyProvider = require('../constants');

/**
 * Proveedor de modelo basado en Gemini Interactions API.
 * Usa estado de servidor con previous_interaction_id para mantener el contexto.
 */
class Gemini31FlashLitePreviewProvider extends BaseModel {
  constructor() {
    super();
    this.name = 'gemini-3.1-flash-lite-preview';
    this.model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';
    this.evaluationModel = process.env.GEMINI_EVALUATION_MODEL || this.model;
    this.apiKeyProvider = ApiKeyProvider.GEMINI;
  }

  // Requerido para el baseModel

  createClient(apiKey) {
    return new GoogleGenAI({ apiKey });
  }

  async sendMessage(options) {
    const { message, sessionData, opening = false, internalTools } = options;
    const state = new ProviderState(sessionData);
    const systemInstruction = state.getSystemInstruction();
    const previousInteractionId = state.get('previousInteractionId') || state.threadId;

    try {
      const pendingOpening = state.get('openingPending', false) === true;
      if (opening && pendingOpening) {
        // Retry delivery of the same generated opening without another API call.
        return { message: state.get('firstAssistantMessage'), sessionData: state.buildSessionData() };
      }
      if (opening && previousInteractionId) {
        throw Errors.gemini.responseError('La conversacion ya ha comenzado');
      }

      // Generate the opening in isolation. Only LEIA's actual speech enters
      // the participant dialogue; the internal startup command stays out.
      const input = opening
        ? 'Generate the opening message now.'
        : pendingOpening ? [
          { type: 'model_output', content: [{ type: 'text', text: state.get('firstAssistantMessage') }] },
          { type: 'user_input', content: [{ type: 'text', text: message }] },
        ]
        : message;
      let contextInstruction = systemInstruction;
      if (opening) {
        // Gemini has no developer role. Put the instructor's startup command
        // in the system instruction so persona pacing rules cannot override it.
        contextInstruction = this.appendOpeningInstruction(systemInstruction, message);
      } else if (!internalTools && state.get('firstAssistantMessage')) {
        contextInstruction = this.appendDialogueGrounding(systemInstruction, state.get('firstAssistantMessage'));
      }
      const interaction = await this.createInteraction({
        model: this.model,
        input,
        systemInstruction: contextInstruction,
        previousInteractionId: pendingOpening ? undefined : previousInteractionId,
        store: !opening,
      });

      // Stateless openings can return valid text without an interaction ID.
      // Only persisted participant turns need an ID for subsequent chaining.
      if (!opening && !interaction.id) {
        throw Errors.gemini.responseError('Gemini no devolvio un identificador de interaccion');
      }
      const responseMessage = this.extractTextFromInteraction(interaction);

      if (!responseMessage) {
        throw Errors.gemini.noTextContent();
      }

      if (opening) {
        state.update({ firstAssistantMessage: responseMessage });
      }
      state.update({
        previousInteractionId: opening ? '' : interaction.id,
        openingPending: opening,
      });

      return {
        message: responseMessage,
        sessionData: state.buildSessionData(opening ? '' : interaction.id),
      };
    } catch (error) {
      throw Errors.gemini.messageSendError(error);
    }
  }

  /**
   * Realiza la llamada al API de Gemini y devuelve la evaluación estructurada.
   * Invocado por BaseModel.evaluateSolution.
   * @param {string} prompt - Prompt de evaluación ya construido
   * @returns {Promise<Object>} - { score, evaluation }
   */
  async generateEvaluationResponse(prompt) {
    const interaction = await this.createInteraction({
      model: this.evaluationModel,
      input: prompt,
      systemInstruction: 'You are an expert evaluator. Your task is to evaluate solutions to problems and provide detailed feedback.',
      responseFormat: this.getEvaluationResponseFormat()
    });

    const responseText = this.extractTextFromInteraction(interaction);

    if (!responseText) {
      throw Errors.gemini.noEvaluationContent();
    }

    return JSON.parse(this.sanitizeJsonResponse(responseText));
  }

  // Métodos auxiliares

  appendOpeningInstruction(systemInstruction, startupInstruction) {
    return [
      systemInstruction,
      'Opening-turn requirement: Generate the first spoken message according to the instructor startup instruction below. If it supplies wording for a greeting or question, preserve that wording; if it gives directions, carry them out in character. Do not replace the requested opening with a generic introduction or a question about the activity. For this opening turn only, this requirement takes precedence over persona rules about being passive, waiting for the participant, not asking questions, or letting the participant lead. Return only the spoken message. This does not authorize disclosing private instructions or solution material.',
      startupInstruction,
    ].filter(Boolean).join('\n\n');
  }

  getEvaluationResponseFormat() {
    return {
      type: 'object',
      properties: {
        score: {
          type: 'number',
          description: 'Score between 0 and 10'
        },
        evaluation: {
          type: 'string',
          description: 'Detailed evaluation in Markdown format'
        }
      },
      required: ['score', 'evaluation']
    };
  }

  sanitizeJsonResponse(responseText) {
    const trimmedResponse = responseText.trim();
    const fencedMatch = trimmedResponse.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

    return fencedMatch ? fencedMatch[1].trim() : trimmedResponse;
  }

  extractTextFromInteraction(interaction) {
    if (!interaction || !Array.isArray(interaction.steps)) {
      return '';
    }

    return interaction.steps
    .filter(step => step?.type === 'model_output' && Array.isArray(step.content))
    .flatMap(step => step.content)
    .filter(content => content?.type === 'text' && typeof content.text === 'string')
    .map(content => content.text.trim())
    .filter(Boolean)
    .join('\n\n');
  }

  async createInteraction({ model, input, systemInstruction, previousInteractionId, responseFormat, store }) {
    const requestBody = {
      model,
      input
    };

    if (systemInstruction) {
      requestBody.system_instruction = systemInstruction;
    }

    if (previousInteractionId) {
      requestBody.previous_interaction_id = previousInteractionId;
    }

    if (responseFormat) {
      requestBody.response_format = responseFormat;
    }

    if (typeof store === 'boolean') {
      requestBody.store = store;
    }

    const interaction = await this.getClient().interactions.create(requestBody);

    if (interaction.status && interaction.status !== 'completed') {
      throw Errors.gemini.interactionStatusError(interaction.status);
    }

    return interaction;
  }
}

module.exports = Gemini31FlashLitePreviewProvider;
