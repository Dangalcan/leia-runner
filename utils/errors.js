const createError = require('http-errors');

const baseModel = {
  missingInstruction: () =>
    createError(500, 'systemInstruction ausente en providerState; posible sesion corrupta'),

  missingInstructionOnCreate: () =>
    createError(400, 'instructions es requerida para crear una sesion'),

  evaluationError: (originalError) => {
    console.error('Error durante la evaluacion de la solucion:', originalError);
    return createError(500, 'Error evaluando la solucion');
  }
};

const openAI = {
  noConversationId: () =>
    createError(500, 'OpenAI no devolvio un identificador de conversacion'),

  noTextContent: () =>
    createError(500, 'OpenAI no devolvio contenido de texto'),

  noEvaluation: () =>
    createError(500, 'OpenAI no devolvio una evaluacion estructurada'),

  responseError: (message) =>
    createError(500, message || 'OpenAI devolvio un error al generar la respuesta'),

  sessionCreationError: (originalError) => {
    console.error('Error al crear sesion con OpenAI Conversations:', originalError);
    return createError(500, 'Error creando sesion');
  },

  messageSendError: (originalError) => {
    console.error('Error enviando mensaje a OpenAI Conversations:', originalError);
    return createError(500, 'Error enviando mensaje');
  },

  evaluationError: (originalError) => {
    console.error('Error evaluando solucion con OpenAI:', originalError);
    return createError(500, 'Error evaluando la solucion con OpenAI');
  },
};

const gemini = {

  responseError: (message) =>
    createError(500, message || 'Gemini devolvio un error al generar la respuesta'),

  noTextContent: () => createError(500, 'Gemini no devolvio contenido de texto'),

  noEvaluationContent: () =>
    createError(500, 'Gemini no devolvio contenido para la evaluacion'),

  interactionStatusError: (status) =>
    createError(500, `La interaccion de Gemini termino con estado: ${status}`),

  messageSendError: (originalError) => {
    console.error('Error enviando mensaje a Gemini:', originalError);
    return createError(500, 'Error enviando mensaje a Gemini');
  },
};

const ollama = {
  missingSessionId: () =>
    createError(400, 'sessionId es requerido para usar el proveedor Ollama'),

  noTextContent: () =>
    createError(500, 'Ollama no devolvio contenido de texto'),

  noEvaluationContent: () =>
    createError(500, 'Ollama no devolvio contenido para la evaluacion'),

  messageSendError: (originalError) => {
    console.error('Error enviando mensaje a Ollama:', originalError);
    return createError(500, 'Error enviando mensaje a Ollama');
  },

  evaluationError: (originalError) => {
    console.error('Error evaluando solucion con Ollama:', originalError);
    return createError(500, 'Error evaluando la solucion con Ollama');
  },
};

const alma = {
  missingSessionId: () =>
    createError(400, 'sessionId is required to use ALMA provider'),

  noTextContent: () =>
    createError(500, 'ALMA did not return text content'),

  noEvaluationContent: () =>
    createError(500, 'ALMA did not return evaluation content'),

  messageSendError: (originalError) => {
    console.error('Error sending message to ALMA:', originalError);
    return createError(500, 'Error sending message to ALMA');
  },

  evaluationError: (originalError) => {
    console.error('Error evaluating solution with ALMA:', originalError);
    return createError(500, 'Error evaluating the solution with ALMA');
  },
};

const Errors = {
  baseModel,
  openAI,
  gemini,
  ollama,
  alma,
};

module.exports = Errors;
