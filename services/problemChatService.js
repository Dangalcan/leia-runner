const { OpenAI, toFile } = require('openai');
const { redisClient } = require('../config/redis');
const apiKeyService = require('./apiKeyService');
const { normalizeTools } = require('../utils/problemChatTools');
const { CORE_PLACEHOLDERS } = require('../utils/behaviourTemplate');

// Same tool wire-format as the LEIA message flow: the FE sends tools as
// { name, description, parameters }; we return { toolCalls:[{callId,name,arguments}] }
// and accept { toolResults }. Kept self-contained here so the problem-chat does
// not depend on the openai-responses provider internals.
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

// Design-time assistant. Tool availability is role- and feature-dependent:
// basic users can select a Behaviour but cannot author the base resource, and
// rubrics are optional — included only when the instructor adds one.
const CORE_PROMPT_INTRO_WITHOUT_RUBRIC = [
  'You help an instructor design a whole LEIA for an educational platform where students practice by interacting with an AI that simulates a real-world scenario. A LEIA is made of three resources: a PROBLEM (the scenario/task the student works on), a BEHAVIOUR (the role the AI plays opposite the student) and a PERSONA (the character the AI embodies).',
  'A LEIA problem spec has: description, personaBackground, details, solution, initialSolution, solutionFormat (one of: text, mermaid, yaml, markdown, html, json, xml), evaluationPrompt, process, the advanced composition fields extends/overrides/constrainedTo, and optionally widgets (interactive tools the activity uses).',
  'A behaviour spec has: description (how the AI acts, what it knows/withholds), role, process[], tooltip. A persona spec has: fullName, firstName, description, personality, and pronouns (subjectPronoum/objectPronoum/possesivePronoum/possesiveAdjective).',
  'Tools, provided by the editor (call get_current_* before modifying an existing resource):',
  '- get_current_problem() / apply_problem(spec): read / write the problem.',
  '- get_current_behaviour(): read the selected behaviour. apply_behaviour is available only when the current user may author Behaviour resources.',
  '- get_current_persona() / apply_persona(spec): read / write the persona.',
  '- list_problems() / use_problem(id): list accessible EXISTING problems and select one.',
  '- list_behaviours() / use_behaviour(id): list accessible saved behaviours AND previous drafts from this conversation and select one, including a generated-* draft id actually returned by the latest list.',
  '- list_personas() / use_persona(id): list the instructor\'s EXISTING personas and reuse one by id when suitable.',
  'Every apply_* takes a `name` (short kebab-case) — ALWAYS set it so the instructor does not have to rename the resource afterwards.',
];

const CORE_PROMPT_INTRO_WITH_RUBRIC = [
  'You help an instructor design a whole LEIA for an educational platform where students practice by interacting with an AI that simulates a real-world scenario. A LEIA is made of four resources: a PROBLEM (the scenario/task the student works on), a BEHAVIOUR (the role the AI plays opposite the student), a PERSONA (the character the AI embodies), and a RUBRIC (the criteria used to evaluate the student\'s work).',
  'A LEIA problem spec has: description, personaBackground, details, solution, initialSolution, solutionFormat (one of: text, mermaid, yaml, markdown, html, json, xml), evaluationPrompt, process, the advanced composition fields extends/overrides/constrainedTo, and optionally widgets (interactive tools the activity uses).',
  'A behaviour spec has: description (how the AI acts, what it knows/withholds), role, process[], tooltip. A persona spec has: fullName, firstName, description, personality, and pronouns (subjectPronoum/objectPronoum/possesivePronoum/possesiveAdjective).',
  'A rubric resource is structured JSON with apiVersion "v1", metadata.name, and spec ({ evaluationPrompt, sections }). Every section has title, numeric weight, ordered levels, and criteria. Every criterion has a name and one descriptor per level ({level, description}). Section weights must total 100. Levels must be ordered from worst to best. spec.evaluationPrompt is optional instructions explaining how to apply the rubric and may use placeholders like {{currentStage.outputs.conversation}}, {{currentStage.outputs.submitedSolution}}, {{previousStage.outputs.conversation}}, {{previousStage.outputs.submitedSolution}}, {{problem.*}}, {{persona.*}} and {{behaviour.*}}. The rubric assesses whether the student can explain, justify and apply the concepts, decisions and trade-offs behind their solution, not only whether the final output looks correct.',
  'Tools, provided by the editor (call get_current_* before modifying an existing resource):',
  '- get_current_problem() / apply_problem(spec): read / write the problem.',
  '- get_current_behaviour(): read the selected behaviour. apply_behaviour is available only when the current user may author Behaviour resources.',
  '- get_current_persona() / apply_persona(spec): read / write the persona.',
  '- get_current_rubric() / apply_rubric(rubric): read / write the complete structured rubric.',
  '- list_problems() / use_problem(id): list accessible EXISTING problems and select one.',
  '- list_behaviours() / use_behaviour(id): list accessible saved behaviours AND previous drafts from this conversation and select one, including a generated-* draft id actually returned by the latest list.',
  '- list_personas() / use_persona(id): list the instructor\'s EXISTING personas and reuse one by id when suitable.',
  'Every apply_* must set a short kebab-case resource name — ALWAYS set it so the instructor does not have to rename the resource afterwards. For apply_rubric put it in metadata.name; the other tools use their top-level name argument.',
];

const SHARED_WORKFLOW_PROMPT = [
  'Mandatory reuse-first workflow:',
  '- When the user asks for an activity/LEIA (or attaches a PDF), infer the requested scenario, learning objective, process, expected solution, AI role and persona before choosing resources.',
  '- Before creating a Problem, call list_problems. Use use_problem when an existing Problem materially matches the scenario, learning objective and expected output. Call apply_problem only after inspecting the list and only when no suitable Problem exists. A merely related topic is not a match.',
  '- After the final Problem is selected or created, call list_behaviours. Use use_behaviour when an existing Behaviour has the needed role and its process list exactly matches the Problem process. Do not require exercise-specific wording when a generic reusable role already supplies the right interaction pattern.',
  '- When the user changes only the Problem scenario (for example, from a library to a gym), first inspect the current Behaviour. A reusable role whose {{problem.*}} and {{persona.*}} references provide the changing context should be reused unchanged. Applying a Problem temporarily clears the Behaviour selection, but the previous draft remains in list_behaviours; explicitly reselect it with use_behaviour after inspecting that list. Do not create a replacement merely because the scenario changed. Still reject incompatible hardcoded case instructions or a different process.',
  '- Before creating a Persona, call list_personas. Use use_persona when an existing character can naturally play the requested role. Call apply_persona only when no suitable Persona exists.',
  '- A list_* call and its corresponding apply_* call MUST NOT be made in the same response. Call list_*, wait for its tool result, inspect that result, and only then decide between use_* and apply_*.',
  '- Call use_problem/use_behaviour/use_persona only with an id present in the corresponding latest list_* result. Never invent ids. A previous Behaviour draft is a valid reuse candidate when its generated-* id is returned by list_behaviours; selecting it preserves that exact draft instead of creating a duplicate.',
  '- Never create a near-duplicate merely to change a name, phrasing, subject example or other non-material detail. Prefer an existing resource plus the Problem composition fields when appropriate.',
  '- If a different Problem is selected or created, do not silently retain an old Behaviour. Explicitly select a compatible Behaviour after searching the library.',
  '- For every process array, "other" is exclusive. Use ["other"] by itself, or use one or more concrete values from "requirements-elicitation" and "game" without "other".',
  '- If the user only asks a question and does not request an editor change, answer without applying resources.',
  '- If the user attaches a PDF and asks to convert it into a problem, read the PDF, reconstruct the scenario, and call apply_problem with a complete spec. If the solution should be a diagram, put valid mermaid in `solution` and set solutionFormat to "mermaid".',
  '- If the user asks to change the current problem, call get_current_problem and get_current_behaviour first, inspect list_problems, then apply_problem with the updated spec if necessary. Preserve existing Problem template references while updating its domain content.',
  '- Keep description/personaBackground/details/solution internally consistent. Template tags like {{persona.firstName}} may be used where natural.',
  `- New or edited Behaviour descriptions must remain reusable runtime templates. Include these references: ${CORE_PLACEHOLDERS.join(', ')}. Preserve any additional template references from the previous Behaviour when editing it. Use references for the scenario, case details, expected solution and persona instead of hardcoding them. A tool error with missingReferences means the editor was not changed: fix those references and retry, or reuse the compatible previous Behaviour.`,
  '- Fill every field you reasonably can.',
  '- extends/overrides/constrainedTo customize the persona/behaviour/problem the activity is paired with. Each is keyed by component (persona/behaviour/problem); each component is { spec: {...fields}, apiVersion? }. extends ADDS to a spec, overrides REPLACES fields, constrainedTo CONSTRAINS. Example: {"extends":{"persona":{"spec":{"personality":["amigable","despistado"]}}},"overrides":{"behaviour":{"spec":{"role":"alumno de instituto"}}},"constrainedTo":{"behaviour":{"spec":{"process":["requirements-elicitation"]},"apiVersion":"v1"}}}. Leave them as {} unless the user asks to customize the persona/behaviour.',
  '- Add widgets ONLY when the activity needs an interactive tool (e.g. a coding exercise needs the code editor). The apply_problem tool lists the available widgets and their tool functions; for each tool you may set enabled and a usage note describing when LEIA should use it.',
  '- After applying, briefly summarise what you created or changed. If you cannot produce a valid problem (e.g. the PDF is empty or unreadable), explain why instead of calling apply_problem.',
  'Always respond in the same language as the user or the attached document.',
];

function buildSystemPrompt(tools) {
  const toolNames = new Set(
    (Array.isArray(tools) ? tools : [])
      .map((tool) => tool?.name)
      .filter((name) => typeof name === 'string'),
  );
  const canAuthorBehaviour = toolNames.has('apply_behaviour');
  const canAuthorRubric = toolNames.has('apply_rubric');
  const behaviourRule = canAuthorBehaviour
    ? '- You may call apply_behaviour only after list_behaviours proves there is no suitable existing Behaviour. Its process must exactly match the final Problem process.'
    : '- You cannot author or edit the base Behaviour resource. Never request apply_behaviour. Select an existing Behaviour with use_behaviour only if its role is suitable and its process exactly matches the Problem. If the list contains no compatible Behaviour, do not select an approximate one and do not keep trying other tools: leave Behaviour unselected and immediately explain that an advanced user or administrator must create it. You may still use extends, overrides or constrainedTo inside the Problem to customize a compatible selected Behaviour for this activity.';
  const rubricRules = canAuthorRubric
    ? [
        '- A rubric has been enabled for this LEIA. Whenever assembling a complete activity or materially changing its Problem, also create or update an evaluation rubric with apply_rubric whose criteria directly assess the requested task, learning objectives and expected solution. Never copy an unrelated rubric from a previous activity.',
        '- When authoring a Behaviour for a LEIA with a rubric, you may reference {{rubric.criteria}}, {{rubric.markdown}}, or {{rubric.evaluationPrompt}} in the Behaviour description if the AI should probe topics aligned with the rubric.',
      ]
    : [];

  return [
    ...(canAuthorRubric ? CORE_PROMPT_INTRO_WITH_RUBRIC : CORE_PROMPT_INTRO_WITHOUT_RUBRIC),
    ...SHARED_WORKFLOW_PROMPT,
    behaviourRule,
    ...rubricRules,
  ].join('\n');
}

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
      instructions: buildSystemPrompt(normalizedTools),
      // Resource selection is order-sensitive: the model must receive a
      // list_* result before it can safely choose use_* or apply_*.
      parallel_tool_calls: false,
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
module.exports.buildSystemPrompt = buildSystemPrompt;
module.exports.normalizeTools = normalizeTools;
