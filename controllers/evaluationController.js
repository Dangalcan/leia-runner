const modelManager = require('../models/modelManager');
const sessionService = require('../services/sessionService');

function parseStoredRubric(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports.evaluateSolution = async function evaluateSolution(req, res) {
  try {
    const {
      sessionId,
      result,
      evaluationMode,
      rubric: requestRubric,
      context,
      language,
      runnerConfiguration,
    } = req.body || {};

    if (!sessionId) {
      return res.status(400).send({ error: 'SessionId is required' });
    }

    const mode = evaluationMode === 'rubric' ? 'rubric' : 'classic';

    if (mode === 'classic' && !result) {
      return res.status(400).send({ error: 'SessionId and result are required' });
    }

    // Obtener la sesión en Redis (o usar runnerConfiguration explícito si la sesión
    // ya no está en caché, p. ej. audio Luke / MultiLEIA / sesión expirada).
    const sessionData = await sessionService.getSession(sessionId);
    const providerConfig = sessionData || runnerConfiguration;
    if (!providerConfig?.provider) {
      return res.status(404).send({ error: `Session with ID: ${sessionId} not found` });
    }

    const leiaMeta = await sessionService.getLeiaMeta(sessionId);
    if (mode === 'classic' && !leiaMeta) {
      return res.status(404).send({ error: `LEIA metadata for session ID: ${sessionId} not found` });
    }

    const token = `${providerConfig.provider}:${providerConfig.modelName || ''}:${providerConfig.apiKeyId || ''}`;
    const model = await modelManager.getModel(
      providerConfig.provider,
      providerConfig.apiKeyId,
      providerConfig.apiKeyRequesterId,
      token
    );

    if (mode === 'rubric') {
      const rubric = requestRubric || parseStoredRubric(leiaMeta?.rubric);
      if (!rubric?.spec?.sections?.length) {
        return res.status(400).send({ error: 'A valid structured rubric is required for rubric evaluation' });
      }
      const evaluationContext = {
        ...(context || {}),
        currentStage: {
          outputs: {
            ...(context?.currentStage?.outputs || {}),
            ...(result !== undefined && context?.currentStage?.outputs?.submitedSolution === undefined
              ? { submitedSolution: result }
              : {}),
          },
        },
      };
      const evaluationResult = await model.evaluateWithRubric({
        rubric,
        context: evaluationContext,
        language: language || leiaMeta?.language || 'en',
      });
      return res.status(200).send(evaluationResult);
    }

    // Evaluar la solución de forma clásica
    const evaluationResult = await model.evaluateSolution({
      leiaMeta,
      result
    });

    res.status(200).send({
      evaluationMode: 'classic',
      ...evaluationResult,
    });
  } catch (error) {
    console.error(`Error evaluating solution for session ${req.body?.sessionId}:`, error);
    res.status(500).send({ error: 'Internal error evaluating solution' });
  }
};