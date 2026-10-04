const Errors = require('../../utils/errors');
const Prompts = require('../../utils/prompts');
const ProviderState = require('../providerState');

class BaseModel {
  constructor() {
    this.name = 'base';
    this._client = null;
    this.apiKeyProvider = null;
    this.apiKey = null;
  }

  // Methods implemented for all providers by default
  setBaseURL(url) {
    this.baseUrl = url.replace(/\/+$/, '');
  }
  setApiKey(apiKey) {
    this.apiKey = apiKey;
  }
  /**
   * Obtiene el API key del proveedor desde la variable de entorno.
   * @returns {string|undefined}
   */
  getApiKey() {
    // Se podria llamar aqui al servicio de obtener la apikey con el Desginer intern tooken
    return  this.apiKey;
  }

  /**
   * Valida que el API key esté configurado.
   * @returns {string}
   */
  ensureApiKey() {
    const apiKey = this.getApiKey();

    if (!apiKey) {
      throw new Error('API key is not configured');
    }

    return apiKey;
  }

  /**
   * Obtiene el tipo de API key del proveedor.
   * @returns {string}
   * @throws {Error} Si el apiKeyProvider no está configurado en la subclase
   */
  getApiKeyProvider() {
    if (!this.apiKeyProvider) {
      throw new Error('apiKeyProvider is not configured for this provider');
    }

    return this.apiKeyProvider;
  }
   /**
   * Obtiene el cliente del proveedor (lazy initialization).
   * @returns {Object} Cliente del proveedor
   * @throws {Error} Si la API key no está configurada
   */
  getClient() {
    const apiKey = this.ensureApiKey();
    if (!this._client) {
      this._client = this.createClient(apiKey);
    }
    return this._client;
  }

  /**
   * Obtiene el estado del proveedor desde sessionData usando ProviderState.
   * Este método centraliza la lógica de extracción de estado de sesión.
   * @param {Object} sessionData - Datos de sesión
   * @returns {Object} Estado del proveedor
   */
  getProviderState(sessionData = {}) {
    const state = new ProviderState(sessionData);

    return {
      threadId: state.threadId,
      systemInstruction: state.getSystemInstruction(),
      providerState: state.providerState,
    };
  }

  /**
   * Crea una nueva sesión
   * @param {Object} options - Opciones para crear la sesión
   * @returns {Promise<Object>} - Datos de la sesión creada
   */
  async createSession(options) {
    const { instructions } = options;

    if (!instructions) {
      throw Errors.baseModel.missingInstructionOnCreate();
    }

    const threadId = await this.setThreadId();

    return {
      threadId,
      providerState: {
        systemInstruction: instructions
      }
    };
  }

  /**
   * Evalúa una solución de estudiante
   * @param {Object} options - Opciones para la evaluación
   * @param {Object} options.leiaMeta - Objeto LEIA con la configuración del problema
   * @param {string} options.result - Solución proporcionada por el estudiante
   * @returns {Promise<Object>} - Resultado de la evaluación
   */
  async evaluateSolution(options) {
    const { leiaMeta, result } = options;
    const { solution, solutionFormat, evaluationPrompt } = leiaMeta;

    try {
      const prompt = Prompts.evaluation(solution, result, solutionFormat, evaluationPrompt);

      const responseParsed = await this.generateEvaluationResponse(prompt);

      return responseParsed;
    } catch (error) {
      throw Errors.baseModel.evaluationError(error);
    }
  }

 // To be implemented by each provider

  /**
   * Crea el cliente del proveedor. Debe ser implementado por cada subclase.
   * Solo se invoca una vez, la primera vez que se necesita el cliente.
   * @returns {Object} Cliente del proveedor
   */
  createClient() {
    throw new Error('Method createClient must be implemented by subclasses');
  }

  /**
   * Envía un mensaje a la sesión
   * @param {Object} options - Opciones para enviar el mensaje
   * @returns {Promise<Object>} - Respuesta del modelo
   */
  async sendMessage(options) {
    throw new Error('Method sendMessage must be implemented by subclasses');
  }

  /**
   * Define el threadId para la sesión. Este método debe ser implementado por cada proveedor para determinar cómo manejar el contexto de la conversación.
   * @returns {string} El threadId a usar para la sesión, o un string vacío si el proveedor no utiliza threadId.
   */
  async setThreadId() {
    return '';
  }

  /**
   * Genera la respuesta de evaluación a partir de la respuesta cruda del modelo.
   * Este método debe ser implementado por cada proveedor para definir cómo se procesa la respuesta del modelo para obtener la evaluación estructurada.
   * @returns {Object} La evaluación estructurada a partir de la respuesta del modelo
   * @throws {Error} Si el método no es implementado por la subclase
   */
  generateEvaluationResponse() {
    throw new Error('Method generateEvaluationResponse must be implemented by subclasses');
  }
}

module.exports = BaseModel;