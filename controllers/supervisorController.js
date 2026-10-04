const supervisorService = require('../services/supervisorService');

/**
 * Observe an activity transcript window and return structured flags (+ optional
 * student nudge). Stateless. The workbench calls this fire-and-forget.
 *
 * Body: {
 *   transcript: [{ role: 'student'|'leia', text }],
 *   existingFlags?: [{ category, severity, note, quote }],
 *   runnerConfiguration: { apiKeyId, apiKeyRequesterId, modelName },
 *   supervisorConfig: { instructions, categories?, sensitivity?, intervene?, interveneInstructions?, model? }
 * }
 * POST /api/v1/supervisor
 */
const observe = async (req, res) => {
  try {
    const { transcript, existingFlags, runnerConfiguration, supervisorConfig } = req.body;
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res.status(400).json({ error: 'A non-empty transcript is required' });
    }
    const result = await supervisorService.observe({
      runnerConfiguration: runnerConfiguration || {},
      transcript,
      existingFlags: Array.isArray(existingFlags) ? existingFlags : [],
      config: supervisorConfig || {},
    });
    res.status(200).json(result);
  } catch (error) {
    console.error('Error in supervisor observation:', error);
    res
      .status(error.statusCode || 500)
      .json({ error: 'Failed to run supervisor observation', message: error.message });
  }
};

module.exports = { observe };
