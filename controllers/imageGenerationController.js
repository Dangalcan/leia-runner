const imageService = require("../services/imageGenerationService");

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getApiKeyConfig(req) {
  const { apiKeyId, apiKeyRequesterId } = req.body || {};
  if (!apiKeyId || !apiKeyRequesterId) {
    return null;
  }
  return { apiKeyId, apiKeyRequesterId };
}

function handleGenerationError(res, error, logMessage, responseError) {
  console.error(`${logMessage}:`, error);

  if (error.code === "invalid_api_key" || error.message?.includes("API_KEY is not configured")) {
    return res.status(error.statusCode || 500).json({
      error: "AI provider configuration error",
      message: error.message,
    });
  }

  const statusCode = error.statusCode || error.response?.status || 500;
  return res.status(statusCode).json({
    error: responseError,
    message: error.message,
  });
}

async function handleAvatarGeneration(res, generator, payload, apiKeyConfig, logLabel) {
  try {
    const result = await generator(payload, apiKeyConfig);
    res.json(result);
  } catch (error) {
    return handleGenerationError(
      res,
      error,
      `Error generating ${logLabel} avatar`,
      `Failed to generate ${logLabel} avatar`
    );
  }
}

const generatePersonaAvatar = async (req, res) => {
  const { persona } = req.body;
  const apiKeyConfig = getApiKeyConfig(req);

  if (!isObject(persona)) {
    return res.status(400).json({ error: "Persona is required" });
  }
  if (!apiKeyConfig) {
    return res.status(400).json({ error: "apiKeyId and apiKeyRequesterId are required" });
  }

  return handleAvatarGeneration(
    res,
    imageService.generatePersonaAvatar,
    persona,
    apiKeyConfig,
    "persona"
  );
};

const generateProblemAvatar = async (req, res) => {
  const { problem } = req.body;
  const apiKeyConfig = getApiKeyConfig(req);

  if (!isObject(problem)) {
    return res.status(400).json({ error: "Problem is required" });
  }
  if (!apiKeyConfig) {
    return res.status(400).json({ error: "apiKeyId and apiKeyRequesterId are required" });
  }

  return handleAvatarGeneration(
    res,
    imageService.generateProblemAvatar,
    problem,
    apiKeyConfig,
    "problem"
  );
};

const generateLeiaAvatar = async (req, res) => {
  const { leia } = req.body;
  const apiKeyConfig = getApiKeyConfig(req);

  if (!isObject(leia)) {
    return res.status(400).json({ error: "LEIA is required" });
  }
  if (!apiKeyConfig) {
    return res.status(400).json({ error: "apiKeyId and apiKeyRequesterId are required" });
  }

  return handleAvatarGeneration(
    res,
    imageService.generateLeiaAvatar,
    leia,
    apiKeyConfig,
    "LEIA"
  );
};

const generateInfographic = async (req, res) => {
  const { leia, solution } = req.body;
  const apiKeyConfig = getApiKeyConfig(req);

  if (!isObject(leia)) {
    return res.status(400).json({ error: "LEIA is required" });
  }
  if (!apiKeyConfig) {
    return res.status(400).json({ error: "apiKeyId and apiKeyRequesterId are required" });
  }

  try {
    const result = await imageService.generateInfographic(leia, solution, apiKeyConfig);
    res.json(result);
  }
  catch (error) {
    return handleGenerationError(
      res,
      error,
      "Error generating infographic",
      "Failed to generate infographic"
    );
  }
};

module.exports = {
  generatePersonaAvatar,
  generateProblemAvatar,
  generateLeiaAvatar,
  generateInfographic
};
