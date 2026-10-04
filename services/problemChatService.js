const { OpenAI, toFile } = require('openai');
const { redisClient } = require('../config/redis');
const apiKeyService = require('./apiKeyService');

// Same tool wire-format as the LEIA message flow: the FE sends tools as
// { name, description, parameters }; we return { toolCalls:[{callId,name,arguments}] }
// and accept { toolResults }. Kept self-contained here so the problem-chat does
// not depend on the openai-responses provider internals.
function normalizeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t.name !== 'string') continue;
    out.push({
      type: 'function',
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      parameters:
        t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} },
    });
  }
  return out.length > 0 ? out : null;
}

function extractToolCalls(response) {
  if (!Array.isArray(response?.output)) return [];
  const calls = [];
  for (const item of response.output) {
    if (!item || item.type !== 'function_call') continue;
    calls.push({
      callId: item.call_id || item.id,
      name: item.name,
      arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
    });
  }
  return calls;
}

function extractResponseText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }
  if (!Array.isArray(response?.output)) return '';
  return response.output
    .filter((item) => item?.type === 'message' && Array.isArray(item.content))
    .flatMap((item) => item.content)
    .filter((content) => content?.type === 'output_text' && typeof content.text === 'string')
    .map((content) => content.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

const STORE_PREFIX = 'problemchat:';
const TTL_SECONDS = 6 * 60 * 60; // 6h — design-time assistant, ephemeral.

// Design-time assistant. The editor registers all tools (get_current_problem/
// apply_problem, get_current_behaviour/apply_behaviour, get_current_persona/
// apply_persona); here we only describe how/when to use them.
const SYSTEM_PROMPT = [
  'You help an instructor design a whole LEIA for an educational platform where students practice by interacting with an AI that simulates a real-world scenario. A LEIA is made of three resources: a PROBLEM (the scenario/task the student works on), a BEHAVIOUR (the role the AI plays opposite the student) and a PERSONA (the character the AI embodies).',
  'A LEIA problem spec has: description, personaBackground, details, solution, initialSolution, solutionFormat (one of: text, mermaid, yaml, markdown, html, json, xml), evaluationPrompt, process, the advanced composition fields extends/overrides/constrainedTo, and optionally widgets (interactive tools the activity uses).',
  'A behaviour spec has: description (how the AI acts, what it knows/withholds), role, process[], tooltip. A persona spec has: fullName, firstName, description, personality, and pronouns (subjectPronoum/objectPronoum/possesivePronoum/possesiveAdjective).',
  'Tools, provided by the editor (call get_current_* before modifying an existing resource):',
  '- get_current_problem() / apply_problem(spec): read / write the problem.',
  '- get_current_behaviour() / apply_behaviour(spec): read / write the behaviour.',
  '- get_current_persona() / apply_persona(spec): read / write the persona.',
  '- list_personas() / use_persona(id): list the instructor\'s EXISTING personas and reuse one by id when suitable.',
  'Every apply_* takes a `name` (short kebab-case) — ALWAYS set it so the instructor does not have to rename the resource afterwards.',
  'Guidance:',
  '- When the user asks for an activity/LEIA (or attaches a PDF), assemble the WHOLE LEIA: a problem, a behaviour and a persona that fit together. Always create a NEW behaviour with apply_behaviour, tailored to the exact problem being created; never reuse or copy an exercise-specific behaviour from a different activity. For the persona, first call list_personas and reuse it with use_persona when suitable, or create one with apply_persona. Write the problem with apply_problem. If the user only asks a question and does not request an editor change, answer without applying resources.',
  '- The behaviour must be semantically consistent with the current problem, not merely share its broad process tag. Include the actual subject, task and technology or programming language when relevant. For example, a Python exercise about files, APIs or sorting must not receive an anagrams behaviour simply because both are Python exercises.',
  '- Whenever apply_problem creates or materially changes a problem, also call apply_behaviour in the same turn so the editor never keeps a behaviour from the previous exercise.',
  '- If the user attaches a PDF and asks to convert it into a problem, read the PDF, reconstruct the scenario, and call apply_problem with a complete spec. If the solution should be a diagram, put valid mermaid in `solution` and set solutionFormat to "mermaid".',
  '- If the user asks to change the current problem, call get_current_problem first, then apply_problem with the updated spec.',
  '- Keep description/personaBackground/details/solution internally consistent. Template tags like {{persona.firstName}} may be used where natural.',
  '- Fill every field you reasonably can.',
  '- extends/overrides/constrainedTo customize the persona/behaviour/problem the activity is paired with. Each is keyed by component (persona/behaviour/problem); each component is { spec: {...fields}, apiVersion? }. extends ADDS to a spec, overrides REPLACES fields, constrainedTo CONSTRAINS. Example: {"extends":{"persona":{"spec":{"personality":["amigable","despistado"]}}},"overrides":{"behaviour":{"spec":{"role":"alumno de instituto"}}},"constrainedTo":{"behaviour":{"spec":{"process":["requirements-elicitation"]},"apiVersion":"v1"}}}. Leave them as {} unless the user asks to customize the persona/behaviour.',
  '- Add widgets ONLY when the activity needs an interactive tool (e.g. a coding exercise needs the code editor). The apply_problem tool lists the available widgets and their tool functions; for each tool you may set enabled and a usage note describing when LEIA should use it.',
  '- After applying, briefly summarise what you created or changed. If you cannot produce a valid problem (e.g. the PDF is empty or unreadable), explain why instead of calling apply_problem.',
  'Always respond in the same language as the user or the attached document.',
].join('\n');

class ProblemChatService {
  _key(chatId) {
    return `${STORE_PREFIX}${chatId}`;
  }

  async _get(chatId) {
    const raw = await redisClient.get(this._key(chatId));
    return raw ? JSON.parse(raw) : null;
  }

  async _set(chatId, data) {
    await redisClient.set(this._key(chatId), JSON.stringify(data), { EX: TTL_SECONDS });
  }

  async openSession(chatId, runnerConfiguration = {}) {
    await this._set(chatId, { runnerConfiguration, fileIds: [], responseId: null });
    return { chatId };
  }

  // BYOK: resolve the instructor's OpenAI key (via the auth service) and build a
  // per-request client. The chat always runs on OpenAI (Responses API).
  async _client(runnerConfiguration) {
    const { apiKeyId, apiKeyRequesterId } = runnerConfiguration || {};
    const { keyValue, baseUrl } = await apiKeyService.getApiKeyData('openai', apiKeyId, apiKeyRequesterId);
    return new OpenAI({ apiKey: keyValue, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  }

  async uploadFile(chatId, buffer, filename) {
    const session = await this._get(chatId);
    if (!session) {
      const error = new Error('Problem-chat session not found');
      error.statusCode = 404;
      throw error;
    }
    const client = await this._client(session.runnerConfiguration);
    const file = await toFile(buffer, filename || 'document.pdf', { type: 'application/pdf' });
    const uploaded = await client.files.create({ file, purpose: 'user_data' });
    session.fileIds.push(uploaded.id);
    await this._set(chatId, session);
    return { fileId: uploaded.id, filename: filename || 'document.pdf', bytes: buffer.length };
  }

  async sendMessage(chatId, { message, tools, toolResults, fileIds }) {
    const session = await this._get(chatId);
    if (!session) {
      const error = new Error('Problem-chat session not found');
      error.statusCode = 404;
      throw error;
    }

    // Merge any file ids the client reports (robust against a session being
    // re-opened between upload and message). Track which ones we've already
    // sent so each PDF is attached exactly once across the conversation.
    if (Array.isArray(fileIds) && fileIds.length > 0) {
      const merged = new Set(Array.isArray(session.fileIds) ? session.fileIds : []);
      for (const id of fileIds) if (typeof id === 'string') merged.add(id);
      session.fileIds = Array.from(merged);
    }
    if (!Array.isArray(session.sentFileIds)) session.sentFileIds = [];

    const client = await this._client(session.runnerConfiguration);
    const model = session.runnerConfiguration?.modelName || process.env.OPENAI_MODEL || 'gpt-5.4-mini';
    const normalizedTools = normalizeTools(tools);

    let input;
    const hasToolResults = Array.isArray(toolResults) && toolResults.length > 0;
    if (hasToolResults) {
      input = toolResults.map((r) => ({
        type: 'function_call_output',
        call_id: r.callId,
        output: typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? null),
      }));
    } else {
      const content = [];
      // Attach any uploaded PDFs not yet sent in this conversation (each once).
      // Later turns inherit them via previous_response_id.
      const unsent = (session.fileIds || []).filter((id) => !session.sentFileIds.includes(id));
      for (const fileId of unsent) {
        content.push({ type: 'input_file', file_id: fileId });
      }
      content.push({ type: 'input_text', text: message || '' });
      input = [{ role: 'user', content }];
      session.sentFileIds = [...session.sentFileIds, ...unsent];
    }

    const payload = {
      model,
      input,
      store: true,
      instructions: SYSTEM_PROMPT,
    };
    if (session.responseId) payload.previous_response_id = session.responseId;
    if (normalizedTools) payload.tools = normalizedTools;

    const response = await client.responses.create(payload);
    if (response?.error) {
      throw new Error(response.error.message || 'OpenAI response error');
    }

    session.responseId = response.id || session.responseId;
    await this._set(chatId, session);

    const toolCalls = extractToolCalls(response);
    if (toolCalls.length > 0) {
      return { toolCalls, responseId: response.id };
    }
    return { message: extractResponseText(response), responseId: response.id };
  }
}

module.exports = new ProblemChatService();
