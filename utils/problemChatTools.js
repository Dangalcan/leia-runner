const UNSUPPORTED_STRICT_SCHEMA_KEYWORDS = new Set(['$id', '$schema', 'uniqueItems']);

function toOpenAiStrictSchema(value) {
  if (Array.isArray(value)) return value.map(toOpenAiStrictSchema);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !UNSUPPORTED_STRICT_SCHEMA_KEYWORDS.has(key))
      .map(([key, child]) => [key, toOpenAiStrictSchema(child)]),
  );
  if (
    result.type === 'object' &&
    result.additionalProperties === false &&
    result.properties &&
    typeof result.properties === 'object'
  ) {
    const propertyKeys = Object.keys(result.properties);
    if (propertyKeys.length > 0) {
      const existingRequired = Array.isArray(result.required) ? result.required : [];
      result.required = Array.from(new Set([...existingRequired, ...propertyKeys]));
    }
  }
  return result;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string') continue;
    out.push({
      type: 'function',
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      ...(tool.strict === true ? { strict: true } : {}),
      parameters: tool.parameters && typeof tool.parameters === 'object'
        ? (tool.strict === true ? toOpenAiStrictSchema(tool.parameters) : tool.parameters)
        : { type: 'object', properties: {} },
    });
  }
  return out.length > 0 ? out : null;
}

module.exports = { normalizeTools, toOpenAiStrictSchema };
