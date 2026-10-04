const { OpenAI } = require('openai');
const { zodTextFormat } = require('openai/helpers/zod');

const DEFAULT_PROVIDER = 'openai';
const SUPPORTED_PROVIDERS = new Set(['openai', 'gemini']);

class StructuredGenerationService {
  constructor() {
    this.openaiClient = null;
    this.geminiClient = null;
  }

  resolveProvider() {
    const provider = (process.env.AI_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();

    if (!SUPPORTED_PROVIDERS.has(provider)) {
      throw new Error(
        `Unsupported AI_PROVIDER '${provider}'. Supported values: ${Array.from(SUPPORTED_PROVIDERS).join(', ')}`
      );
    }

    return provider;
  }

  getOpenAIClient() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    if (!this.openaiClient) {
      this.openaiClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }

    return this.openaiClient;
  }

  getGeminiClient() {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured');
    }

    if (!this.geminiClient) {
      try {
        const { GoogleGenAI } = require('@google/genai');
        this.geminiClient = new GoogleGenAI({
          apiKey: process.env.GEMINI_API_KEY,
        });
      } catch (error) {
        throw new Error(
          `Could not load @google/genai. Make sure you use Node 20+ and have the dependency installed. Detail: ${error.message}`
        );
      }
    }

    return this.geminiClient;
  }

  async generateObject({
    systemPrompt,
    userPrompt,
    zodSchema,
    schemaName,
    openaiModel,
    geminiModel,
    geminiResponseFormat,
    reasoning,
  }) {
    const provider = this.resolveProvider();

    if (provider === 'gemini') {
      return this.generateWithGemini({
        systemPrompt,
        userPrompt,
        zodSchema,
        geminiModel,
        geminiResponseFormat,
      });
    }

    return this.generateWithOpenAI({
      systemPrompt,
      userPrompt,
      zodSchema,
      schemaName,
      openaiModel,
      reasoning,
    });
  }

  async generateWithOpenAI({
    systemPrompt,
    userPrompt,
    zodSchema,
    schemaName,
    openaiModel,
    reasoning,
  }) {
    const response = await this.getOpenAIClient().responses.parse({
      model: openaiModel,
      input: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      text: {
        format: zodTextFormat(zodSchema, schemaName),
      },
      ...(reasoning ? { reasoning } : {}),
    });

    if (!response.output_parsed) {
      throw new Error('OpenAI did not return a structured response');
    }

    return response.output_parsed;
  }

  async generateWithGemini({
    systemPrompt,
    userPrompt,
    zodSchema,
    geminiModel,
    geminiResponseFormat,
  }) {
    const interaction = await this.getGeminiClient().interactions.create({
      model: geminiModel,
      input: userPrompt,
      system_instruction: systemPrompt,
      ...(geminiResponseFormat ? { response_format: geminiResponseFormat } : {}),
    });

    if (interaction.status && interaction.status !== 'completed') {
      throw new Error(`Gemini interaction finished with status: ${interaction.status}`);
    }

    const responseText = this.extractTextFromInteraction(interaction);

    if (!responseText) {
      throw new Error('Gemini did not return text content');
    }

    let parsed;
    try {
      parsed = JSON.parse(this.sanitizeJsonResponse(responseText));
    } catch (error) {
      throw new Error(`Gemini did not return valid JSON: ${error.message}`);
    }

    return zodSchema.parse(parsed);
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

  sanitizeJsonResponse(responseText) {
    const trimmedResponse = responseText.trim();
    const fencedMatch = trimmedResponse.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

    return fencedMatch ? fencedMatch[1].trim() : trimmedResponse;
  }
}

module.exports = new StructuredGenerationService();
