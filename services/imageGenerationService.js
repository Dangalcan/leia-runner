const { GoogleGenAI } = require("@google/genai");
const prompts = require("../utils/prompts");
const sharp = require("sharp");
const apiKeyService = require("./apiKeyService");

const avatarKbytes = Number(process.env.AVATAR_KBYTES ?? 4);
const MAX_AVATAR_BYTES = avatarKbytes * 1024;
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";

const AVATAR_PROMPTS = {
  persona: prompts.personaAvatar,
  problem: prompts.problemAvatar,
  leia: prompts.leiaAvatar,
};

async function getGeminiClient(apiKeyConfig) {
  const { apiKeyId, apiKeyRequesterId } = apiKeyConfig || {};
  if (!apiKeyId || !apiKeyRequesterId) {
    const error = new Error("Gemini apiKeyId and apiKeyRequesterId are required");
    error.code = "invalid_api_key";
    error.statusCode = 400;
    throw error;
  }

  const { keyValue } = await apiKeyService.getApiKeyData(
    "gemini",
    apiKeyId,
    apiKeyRequesterId
  );

  if (!keyValue) {
    const error = new Error("Gemini API key could not be resolved");
    error.code = "invalid_api_key";
    throw error;
  }

  return new GoogleGenAI({ apiKey: keyValue });
}

function extractImage(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((part) => part.inlineData?.data);

  if (!imagePart) {
    throw new Error("Gemini did not return image data");
  }

  return {
    buffer: Buffer.from(imagePart.inlineData.data, "base64"),
    contentType: imagePart.inlineData.mimeType || "image/png",
  };
}

async function compressAvatarToDataUrl(sourceBuffer) {
  const sizes = [96, 80, 64, 48, 40, 32];
  const qualities = [80, 70, 60, 50, 40, 30, 20];

  for (const size of sizes) {
    for (const quality of qualities) {
      const compressed = await sharp(sourceBuffer)
        .resize(size, size, { fit: "cover", position: "center" })
        .webp({ quality, effort: 6 })
        .toBuffer();
      const dataUrl = `data:image/webp;base64,${compressed.toString("base64")}`;

      if (Buffer.byteLength(dataUrl, "utf8") <= MAX_AVATAR_BYTES) {
        return dataUrl;
      }
    }
  }

  const fallback = await sharp(sourceBuffer)
    .resize(24, 24, { fit: "cover", position: "center" })
    .webp({ quality: 10, effort: 6 })
    .toBuffer();
  const dataUrl = `data:image/webp;base64,${fallback.toString("base64")}`;

  if (Buffer.byteLength(dataUrl, "utf8") > MAX_AVATAR_BYTES) {
    throw new Error("Unable to compress avatar below 4KB");
  }

  return dataUrl;
}

async function generateAvatar(type, payload, apiKeyConfig) {
  const promptBuilder = AVATAR_PROMPTS[type];

  if (!promptBuilder) {
    throw new Error(`Unsupported avatar type: ${type}`);
  }

  const ai = await getGeminiClient(apiKeyConfig);
  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: promptBuilder(payload),
  });

  const { buffer: sourceBuffer } = extractImage(response);
  const avatar = await compressAvatarToDataUrl(sourceBuffer);

  return {
    avatar,
    sizeBytes: Buffer.byteLength(avatar, "utf8"),
  };
}

async function generatePersonaAvatar({ name, description, personality }, apiKeyConfig) {
  return generateAvatar("persona", { name, description, personality }, apiKeyConfig);
}

async function generateProblemAvatar(problem, apiKeyConfig) {
  return generateAvatar("problem", problem, apiKeyConfig);
}

async function generateLeiaAvatar(leia, apiKeyConfig) {
  return generateAvatar("leia", leia, apiKeyConfig);
}

function removeSolutionForStudent(context) {
  const copy = structuredClone(context);
  const problemSpec = copy?.spec?.problem?.spec;

  if (problemSpec) {
    delete problemSpec.solution;
  }

  return copy;
}

function stringifyInfographicContext(context, includeSolution = false) {
  try {
    const normalized = includeSolution ? context : removeSolutionForStudent(context);
    return JSON.stringify(normalized, null, 2);
  } catch {
    return String(context);
  }
}

async function generateInfographic(behaviour, solution = false, apiKeyConfig) {
  const ai = await getGeminiClient(apiKeyConfig);
  const infographicContext = stringifyInfographicContext(behaviour, solution === true);
  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents:
      solution === true
        ? prompts.infographicSolution(infographicContext)
        : prompts.infographic(infographicContext),
  });

  const { buffer: sourceBuffer, contentType } = extractImage(response);
  return {
    infographic: sourceBuffer,
    contentType,
    sizeBytes: sourceBuffer.length,
  };
}

module.exports = {
  generatePersonaAvatar,
  generateProblemAvatar,
  generateLeiaAvatar,
  generateInfographic,
  getGeminiClient
};
