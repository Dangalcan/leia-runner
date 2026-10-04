require('dotenv').config();
const ApiKeyProvider = require('../constants');
const { OpenAI } = require('openai');
const z = require('zod');
const { zodTextFormat } = require('openai/helpers/zod');
const BaseModel = require('./baseModel');
const Errors = require('../../utils/errors');
const ProviderState = require('../providerState');

const EvaluationSchema = z.object({
    score: z.number().min(0).max(10),
    evaluation: z.string(),
});

/**
 * OpenAI provider based on Responses + Conversations.
 */
class OpenAIResponsesProvider extends BaseModel {
    constructor() {
        super();
        this.name = 'openai-responses';
        this.apiKeyProvider = ApiKeyProvider.OPENAI;
        this.model = 'gpt-5.4-mini';
        this.evaluationModel = process.env.OPENAI_EVALUATION_MODEL || 'gpt-5.4-mini';
    }

    // Required for BaseModel

    createClient(apiKey) {
        return new OpenAI({ apiKey });
    }

    async sendMessage(options) {
        const {
            message,
            sessionData,
            tools,
            toolResults,
            allowTools,
            internalTools,
            parallelToolCalls,
            toolChoice,
        } = options;
        const state = new ProviderState(sessionData);
        const baseInstruction = state.getSystemInstruction();
        let conversationId = state.get('conversationId') || (state.threadId.startsWith('conv_') ? state.threadId : '');

        try {
            if (!conversationId) {
                if (sessionData?.threadId) {
                    console.warn(
                        'Legacy Assistants session detected. A new conversation will be started without previous history.'
                    );
                }

                const conversation = await this.createConversation();
                conversationId = conversation.id;
            }

            // Build the input for this turn: either a fresh user message
            // or a batch of function_call_output items continuing a prior
            // tool-call round.
            let input;
            if (Array.isArray(toolResults) && toolResults.length > 0) {
                input = toolResults.map((r) => ({
                    type: 'function_call_output',
                    call_id: r.callId,
                    output: typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? null),
                }));
            } else {
                input = [
                    {
                        role: 'user',
                        content: message,
                    },
                ];
            }

            // Only honor incoming tools when the activity opted-in at
            // session creation time. Otherwise the prompt and request
            // stay tool-free regardless of what the client sends.
            const normalizedTools = allowTools ? this.normalizeTools(tools) : null;
            // Augment the system instruction per-turn with a tool-usage
            // block so the model is told what each tool is for and when
            // to call it. The augmented text is NOT persisted into state
            // — we keep the base instruction stored and re-augment each
            // turn based on the current tool set.
            const instructionsForCall = normalizedTools && !internalTools
                ? this.appendToolUsageBlock(baseInstruction, normalizedTools)
                : baseInstruction;

            const requestPayload = {
                model: this.model,
                conversation: conversationId,
                instructions: instructionsForCall,
                input,
                store: true,
            };

            if (normalizedTools) {
                requestPayload.tools = normalizedTools;
                if (typeof parallelToolCalls === 'boolean') {
                    requestPayload.parallel_tool_calls = parallelToolCalls;
                }
                if (
                    typeof toolChoice === 'string' ||
                    (toolChoice && typeof toolChoice === 'object')
                ) {
                    requestPayload.tool_choice = toolChoice;
                }
            }

            const response = await this.getClient().responses.create(requestPayload);

            if (response?.error) {
                throw Errors.openAI.responseError(response.error.message);
            }

            const toolCalls = this.extractToolCalls(response);
            if (toolCalls.length > 0) {
                state.update({
                    conversationId,
                    systemInstruction: baseInstruction,
                    lastResponseId: response.id || state.get('lastResponseId'),
                });

                return {
                    toolCalls,
                    sessionData: state.buildSessionData(conversationId),
                };
            }

            const responseMessage = this.extractResponseText(response);

            if (!responseMessage) {
                throw Errors.openAI.noTextContent();
            }

            state.update({
                conversationId,
                systemInstruction: baseInstruction,
                lastResponseId: response.id || state.get('lastResponseId'),
            });

            return {
                message: responseMessage,
                sessionData: state.buildSessionData(conversationId),
            };
        } catch (error) {
            throw Errors.openAI.messageSendError(error);
        }
    }

    // Frontend ships tools as { name, description, parameters }. The
    // Responses API expects function tools with { type: "function", ... }.
    normalizeTools(tools) {
        if (!Array.isArray(tools) || tools.length === 0) return null;
        const out = [];
        for (const t of tools) {
            if (!t || typeof t.name !== 'string') continue;
            out.push({
                type: 'function',
                name: t.name,
                description: typeof t.description === 'string' ? t.description : '',
                parameters: t.parameters && typeof t.parameters === 'object'
                    ? t.parameters
                    : { type: 'object', properties: {} },
            });
        }
        return out.length > 0 ? out : null;
    }

    extractToolCalls(response) {
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

    // Appends a per-turn tool-usage block to the LEIA's system instruction
    // so the model is explicitly told (a) the names of the tools it can
    // call, and (b) the circumstances each one is for. We rely on each
    // tool's own description containing a "Call this when…" cue (that is
    // how the widget catalog authors them), so the format here is just a
    // structured listing.
    appendToolUsageBlock(baseInstruction, tools) {
        if (!Array.isArray(tools) || tools.length === 0) return baseInstruction || '';
        const lines = tools.map((t) => {
            const desc = (t.description || '').trim() || 'No description provided.';
            return `- \`${t.name}\`: ${desc}`;
        });
        const block = [
            '',
            '## Available tools',
            '',
            'You have access to the following tool functions. Each description states the circumstances in which the tool should be invoked.',
            '',
            ...lines,
            '',
            'Hard rules for tool use:',
            '- If the user explicitly asks you to put, write, add, insert, or leave something (a comment, example, hint, snippet, explanation, pseudo-code) in the editor — you MUST fulfill the request via the editing tool. Do NOT answer only in chat: the artifact must end up inside the editor.',
            '- Before any edit, call the read tool first so your `find` anchor matches the live editor content.',
            '- Prefer the tools over guessing about state the user controls (their code, their editor).',
            '- Respect the LEIA behaviour: only the behaviour above decides whether you may write the solution itself. By default, help goes in as comments / hints / examples, not as the answer.',
        ].join('\n');
        return ((baseInstruction || '').trim() + '\n\n' + block).trim();
    }

    /**
     * Performs the call to the OpenAI API and returns the structured evaluation.
     * Called by BaseModel.evaluateSolution.
     * @param {string} prompt - Already built evaluation prompt
     * @returns {Promise<Object>} - { score, evaluation }
     */
    async generateEvaluationResponse(prompt) {
        try {
            const response = await this.getClient().responses.parse({
                model: this.evaluationModel,
                input: [
                    {
                        role: 'system',
                        content:
                            'You are an expert evaluator. Your task is to evaluate solutions to problems and provide detailed feedback.',
                    },
                    {
                        role: 'user',
                        content: prompt,
                    },
                ],
                text: {
                    format: zodTextFormat(EvaluationSchema, 'evaluation_result'),
                },
            });

            if (!response.output_parsed) {
                throw Errors.openAI.noEvaluation();
            }

            return response.output_parsed;
        } catch (error) {
            throw Errors.openAI.evaluationError(error);
        }
    }

    // Helper methods

    async createConversation() {
        this.ensureApiKey();

        const conversation = await this.getClient().post('/conversations', { body: {} });

        if (!conversation?.id) {
            throw Errors.openAI.noConversationId();
        }

        return conversation;
    }

    extractResponseText(response) {
        if (typeof response?.output_text === 'string' && response.output_text.trim()) {
            return response.output_text.trim();
        }

        if (!Array.isArray(response?.output)) {
            return '';
        }

        return response.output
            .filter((item) => item?.type === 'message' && Array.isArray(item.content))
            .flatMap((item) => item.content)
            .filter((content) => content?.type === 'output_text' && typeof content.text === 'string')
            .map((content) => content.text.trim())
            .filter(Boolean)
            .join('\n\n');
    }
}

module.exports = OpenAIResponsesProvider;
