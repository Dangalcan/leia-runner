const createError = require('http-errors');

const baseModel = {
  missingInstruction: () =>
    createError(500, 'systemInstruction missing in providerState; possible corrupt session'),

  missingInstructionOnCreate: () =>
    createError(400, 'instructions are required to create a session'),

  evaluationError: (originalError) => {
    console.error('Error during solution evaluation:', originalError);
    return createError(500, 'Error evaluating the solution');
  }
};

const openAI = {
  noConversationId: () =>
    createError(500, 'OpenAI did not return a conversation identifier'),

  noTextContent: () =>
    createError(500, 'OpenAI did not return text content'),

  noEvaluation: () =>
    createError(500, 'OpenAI did not return a structured evaluation'),

  responseError: (message) =>
    createError(500, message || 'OpenAI returned an error generating the response'),

  sessionCreationError: (originalError) => {
    console.error('Error creating session with OpenAI Conversations:', originalError);
    return createError(500, 'Error creating session');
  },

  messageSendError: (originalError) => {
    console.error('Error sending message to OpenAI Conversations:', originalError);
    return createError(500, 'Error sending message');
  },

  evaluationError: (originalError) => {
    console.error('Error evaluating solution with OpenAI:', originalError);
    return createError(500, 'Error evaluating the solution with OpenAI');
  },
};

const gemini = {

  noTextContent: () => createError(500, 'Gemini did not return text content'),

  noEvaluationContent: () =>
    createError(500, 'Gemini did not return evaluation content'),

  interactionStatusError: (status) =>
    createError(500, `Gemini interaction finished with status: ${status}`),

  messageSendError: (originalError) => {
    console.error('Error sending message to Gemini:', originalError);
    return createError(500, 'Error sending message to Gemini');
  },
};

const ollama = {
  missingSessionId: () =>
    createError(400, 'sessionId is required to use Ollama provider'),

  noTextContent: () =>
    createError(500, 'Ollama did not return text content'),

  noEvaluationContent: () =>
    createError(500, 'Ollama did not return evaluation content'),

  messageSendError: (originalError) => {
    console.error('Error sending message to Ollama:', originalError);
    return createError(500, 'Error sending message to Ollama');
  },

  evaluationError: (originalError) => {
    console.error('Error evaluating solution with Ollama:', originalError);
    return createError(500, 'Error evaluating the solution with Ollama');
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
