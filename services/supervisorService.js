const { OpenAI } = require('openai');
const { zodTextFormat } = require('openai/helpers/zod');
const z = require('zod');
const apiKeyService = require('./apiKeyService');

// Background "supervisor" for a LEIA activity. Given the recent transcript of
// what a student and the LEIA exchanged (text chat OR luke audio, both saved as
// plain messages), an LLM watches for the patterns the instructor described
// (e.g. trying to get the model to write the code for them) and returns
// structured flags. When the instructor enabled intervention it may also
// produce a short "nudge" addressed to the student.
//
// Stateless by design: every request carries the transcript window + the
// instructor's supervisor config. BYOK — runs on the LEIA's own OpenAI key,
// resolved through the auth service exactly like the rest of the runner.

const FlagSchema = z.object({
  category: z
    .string()
    .describe('Short label for what was detected (use one of the instructor categories when given).'),
  severity: z.enum(['low', 'medium', 'high']).describe('How serious / confident the observation is.'),
  note: z.string().describe('One concise sentence explaining what the student did, for the instructor.'),
  quote: z
    .string()
    .nullable()
    .describe('A short verbatim excerpt from the student that triggered the flag, or null.'),
});

const SupervisorSchema = z.object({
  flags: z
    .array(FlagSchema)
    .describe('Behaviours worth flagging to the instructor in this window. Empty array when nothing is notable.'),
  nudge: z
    .string()
    .nullable()
    .describe(
      'A short message addressed directly to the STUDENT to gently redirect them, or null when no intervention is warranted / intervention is disabled.',
    ),
});

const SENSITIVITY_GUIDANCE = {
  low: 'Be conservative: only flag clear, unambiguous cases. Prefer an empty list when in doubt.',
  medium: 'Use balanced judgement: flag behaviours you are reasonably confident about.',
  high: 'Be vigilant: flag even mild or borderline cases, but keep notes precise.',
};

function buildSystemPrompt(config = {}) {
  const lines = [
    'You are a background pedagogical supervisor observing a learning activity on an educational platform.',
    'A student is interacting with an AI ("LEIA") that simulates a real-world scenario. You do NOT talk to the LEIA or the student by default — you silently watch the transcript and report observations to the human instructor.',
    'Your job: detect the behaviours the instructor cares about and return them as structured flags. Examples of what an instructor may ask you to watch for: a student trying to get the AI to write/solve the exercise for them, off-task conversation, signs of frustration or disengagement, or (in a research setting) noting behavioural patterns.',
    '',
    'INSTRUCTOR INSTRUCTIONS (what to watch for):',
    config.instructions && config.instructions.trim()
      ? config.instructions.trim()
      : 'No specific instructions were given — use general academic-integrity and engagement judgement.',
  ];

  if (Array.isArray(config.categories) && config.categories.length > 0) {
    lines.push('', 'PREFERRED CATEGORIES (use these labels for the `category` field when applicable):');
    lines.push(config.categories.map((c) => `- ${c}`).join('\n'));
  }

  lines.push('', SENSITIVITY_GUIDANCE[config.sensitivity] || SENSITIVITY_GUIDANCE.medium);

  if (config.intervene) {
    lines.push(
      '',
      'INTERVENTION IS ENABLED. In addition to flags, you MAY produce a short `nudge` written directly to the student (second person, encouraging, never punitive) to gently redirect them when warranted. Only set `nudge` when there is a clear reason; otherwise null. Keep it to 1–2 sentences.',
    );
    if (config.interveneInstructions && config.interveneInstructions.trim()) {
      lines.push(`When/how to nudge: ${config.interveneInstructions.trim()}`);
    }
  } else {
    lines.push('', 'INTERVENTION IS DISABLED. Always set `nudge` to null.');
  }

  lines.push(
    '',
    'Only report what is supported by the transcript. Do not invent. Never reveal the activity solution. Write `note`, `category` and `nudge` in the same language the student is using.',
    'Do not return a flag for a student quote or behaviour that is already listed in EXISTING FLAGS. If the same behaviour continues, only flag new student evidence that is not already covered by a previous flag.',
  );

  return lines.join('\n');
}

function buildExistingFlagsPrompt(existingFlags = []) {
  const rendered = existingFlags
    .filter((f) => f && (typeof f.note === 'string' || typeof f.quote === 'string'))
    .map((f, idx) => {
      const category = typeof f.category === 'string' && f.category.trim() ? f.category.trim() : 'observation';
      const severity = ['low', 'medium', 'high'].includes(f.severity) ? f.severity : 'low';
      const note = typeof f.note === 'string' && f.note.trim() ? f.note.trim() : '';
      const quote = typeof f.quote === 'string' && f.quote.trim() ? ` Quote: "${f.quote.trim()}"` : '';
      return `${idx + 1}. ${category} · ${severity}${note ? ` — ${note}` : ''}${quote}`;
    })
    .join('\n');

  return rendered || '(none)';
}

function buildUserPrompt(transcript = [], existingFlags = []) {
  const rendered = transcript
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .map((t) => {
      const who = t.role === 'leia' || t.role === 'assistant' ? 'LEIA' : 'STUDENT';
      return `${who}: ${t.text.trim()}`;
    })
    .join('\n');

  return [
    'Here is the most recent portion of the activity transcript plus the flags already reported for this session. Analyse the STUDENT turns (LEIA turns are context only) and return only new observations not already covered.',
    '',
    '--- EXISTING FLAGS ---',
    buildExistingFlagsPrompt(existingFlags),
    '--- END EXISTING FLAGS ---',
    '',
    '--- TRANSCRIPT ---',
    rendered || '(empty)',
    '--- END TRANSCRIPT ---',
  ].join('\n');
}

class SupervisorService {
  // BYOK client (same resolution path as problemChatService / sessionService).
  async _client(runnerConfiguration) {
    const { apiKeyId, apiKeyRequesterId } = runnerConfiguration || {};
    const { keyValue, baseUrl } = await apiKeyService.getApiKeyData('openai', apiKeyId, apiKeyRequesterId);
    return new OpenAI({ apiKey: keyValue, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  }

  /**
   * Observe a transcript window and return { flags, nudge }.
   * @param {object} params
   * @param {object} params.runnerConfiguration - { apiKeyId, apiKeyRequesterId, modelName }
   * @param {Array<{role:string,text:string}>} params.transcript
   * @param {Array<{category:string,severity:string,note:string,quote:string|null}>} params.existingFlags
   * @param {object} params.config - supervisorConfig authored in the designer
   */
  async observe({ runnerConfiguration, transcript, existingFlags, config }) {
    const supervisorConfig = config || {};
    const client = await this._client(runnerConfiguration);
    // The supervisor always runs on OpenAI, so the model must be an OpenAI model.
    // Never fall back to the LEIA's runnerConfiguration.modelName (may be gemini/
    // ollama). Use the instructor's explicit choice, else a default OpenAI model.
    const model = supervisorConfig.model || process.env.OPENAI_MODEL || 'gpt-5.4-mini';

    const response = await client.responses.parse({
      model,
      input: [
        { role: 'system', content: buildSystemPrompt(supervisorConfig) },
        { role: 'user', content: buildUserPrompt(transcript, existingFlags) },
      ],
      text: {
        format: zodTextFormat(SupervisorSchema, 'supervisor_observation'),
      },
    });

    if (!response.output_parsed) {
      throw new Error('Supervisor did not return a structured response');
    }

    const parsed = response.output_parsed;
    // Defensive: drop the nudge entirely if intervention is off.
    return {
      flags: Array.isArray(parsed.flags) ? parsed.flags : [],
      nudge: supervisorConfig.intervene ? parsed.nudge || null : null,
    };
  }
}

module.exports = new SupervisorService();
