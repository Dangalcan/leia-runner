const path = require('path');
const dotenv = require('dotenv');
const OpenAI = require('openai').default;

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const problemChatService = require('../services/problemChatService');
const { CORE_PLACEHOLDERS } = require('../utils/behaviourTemplate');

const model = process.env.PROBLEM_CHAT_EVAL_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const cliArgs = process.argv.slice(2);
const optionValue = (name) => {
  const index = cliArgs.indexOf(name);
  return index >= 0 ? cliArgs[index + 1] : undefined;
};
const repeat = Math.max(
  1,
  Number.parseInt(optionValue('--repeat') || process.env.PROBLEM_CHAT_EVAL_REPEAT || '2', 10),
);
const scenarioFilter = optionValue('--scenario');

const functionTool = (name, description, properties = {}, required = []) => ({
  type: 'function',
  name,
  description,
  parameters: {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  },
});

const idParameter = (resource) => ({
  id: { type: 'string', description: `${resource} id returned by the corresponding list tool.` },
});

function buildTools(canAuthorBehaviour) {
  const tools = [
    functionTool('get_current_problem', 'Return the currently selected Problem.'),
    functionTool('list_problems', 'List existing Problems. You MUST wait for and inspect this result before creating a Problem.'),
    functionTool('use_problem', 'Select an existing, semantically suitable Problem instead of creating a duplicate.', idParameter('Problem'), ['id']),
    functionTool('apply_problem', 'Create a new complete Problem only when list_problems contains no semantic match.', {
      name: { type: 'string' },
      description: { type: 'string' },
      details: { type: 'string' },
      solution: { type: 'string' },
      solutionFormat: { type: 'string' },
      process: {
        type: 'array',
        items: { type: 'string', enum: ['requirements-elicitation', 'game', 'other'] },
      },
      extends: { type: 'object' },
      overrides: { type: 'object' },
      constrainedTo: { type: 'object' },
    }, ['name', 'description', 'details', 'solution', 'process']),
    functionTool('get_current_behaviour', 'Return the currently selected Behaviour.'),
    functionTool('list_behaviours', 'List saved Behaviours and previous conversation drafts, with their full instructions. Prefer compatible generic roles with dynamic problem/persona references. Inspect the result before creating a Behaviour.'),
    functionTool('use_behaviour', 'Select a compatible saved or draft Behaviour by an id actually returned by list_behaviours. Preserve its identity and template references; its process must exactly match the Problem.', idParameter('Behaviour'), ['id']),
    functionTool('get_current_persona', 'Return the currently selected Persona.'),
    functionTool('list_personas', 'List existing Personas. You MUST wait for and inspect this result before creating a Persona.'),
    functionTool('use_persona', 'Select an existing suitable Persona instead of creating a duplicate.', idParameter('Persona'), ['id']),
    functionTool('apply_persona', 'Create a new Persona only when list_personas contains no suitable character.', {
      name: { type: 'string' },
      fullName: { type: 'string' },
      firstName: { type: 'string' },
      description: { type: 'string' },
      personality: { type: 'string' },
    }, ['name', 'firstName', 'description']),
    functionTool('set_leia_name', 'Set a concise learner-facing LEIA title.', {
      name: { type: 'string' },
    }, ['name']),
  ];

  if (canAuthorBehaviour) {
    tools.splice(8, 0, functionTool(
      'apply_behaviour',
      `Create a new Behaviour only when list_behaviours contains no compatible reusable role. Keep its instructions reusable and include these runtime references: ${CORE_PLACEHOLDERS.join(', ')}.`,
      {
        name: { type: 'string' },
        description: { type: 'string' },
        role: { type: 'string' },
        process: {
          type: 'array',
          items: { type: 'string', enum: ['requirements-elicitation', 'game', 'other'] },
        },
        tooltip: { type: 'string' },
      },
      ['name', 'description', 'role', 'process'],
    ));
  }

  return tools;
}

const reusableLibrary = {
  problems: [
    {
      id: 'problem-python-anagrams',
      name: 'python-anagrams',
      description: 'Implement a Python function that determines whether two strings are anagrams.',
      details: 'Normalize case and spaces, compare character frequencies, and provide automated tests.',
      solutionPreview: 'Python are_anagrams implementation using character counts.',
      solutionFormat: 'text',
      process: ['other'],
    },
    {
      id: 'problem-library-requirements',
      name: 'library-requirements-interview',
      description: 'Elicit requirements for a public library lending and reservation system.',
      details: 'Interview a librarian about books, members, loans, reservations and overdue notifications.',
      solutionPreview: 'A requirements model for the library system.',
      solutionFormat: 'mermaid',
      process: ['requirements-elicitation'],
    },
  ],
  behaviours: [
    {
      id: 'behaviour-python-coach',
      name: 'python-coding-coach',
      role: 'Python programming mentor',
      description: 'Guides learners with questions and incremental hints without immediately revealing the final code. Reusable across Python implementation exercises.',
      tooltip: 'Ask the Python mentor for a hint.',
      process: ['other'],
    },
    {
      id: 'behaviour-library-client',
      name: 'librarian-interviewee',
      role: 'Public librarian being interviewed by a requirements analyst',
      description: 'Answers questions about lending, reservations, members and overdue items, revealing requirements only when asked.',
      process: ['requirements-elicitation'],
    },
  ],
  personas: [
    {
      id: 'persona-alex-python',
      name: 'alex-python-teacher',
      firstName: 'Alex',
      description: 'Experienced Python instructor who teaches algorithms and implementation skills.',
      personality: 'patient, concise, encouraging',
    },
    {
      id: 'persona-marta-librarian',
      name: 'marta-librarian',
      firstName: 'Marta',
      description: 'Public librarian responsible for lending, reservations and member services.',
      personality: 'practical, attentive, busy',
    },
  ],
};

const unrelatedLibrary = {
  problems: [reusableLibrary.problems[0]],
  behaviours: [reusableLibrary.behaviours[0]],
  personas: [
    {
      id: 'persona-ethan-theatre',
      name: 'ethan-theatre-manager',
      firstName: 'Ethan',
      description: 'Manager of several cinemas focused on ticketing, rooms and show schedules.',
      personality: 'direct, impatient, operational',
    },
  ],
};

const scenarios = [
  {
    id: 'adapt-conversation-draft-to-gym',
    canAuthorBehaviour: true,
    library: { problems: [reusableLibrary.problems[1]], behaviours: [], personas: [reusableLibrary.personas[1]] },
    initialSelection: {
      problem: reusableLibrary.problems[1],
      behaviour: {
        id: 'generated-client-interviewee', name: 'generic-client-interviewee',
        role: 'Client being interviewed by a requirements analyst',
        description: `Play the client described by the current scenario. Answer questions progressively, reveal only the requirements asked about, and never give the complete solution unprompted. Use dynamic context: ${CORE_PLACEHOLDERS.join(', ')}.`,
        process: ['requirements-elicitation'],
      },
      persona: reusableLibrary.personas[1],
    },
    request: 'cambiame el problema para que sea de gestión de un gimnasio con los usuarios los instructores y los planes de entrenamiento',
    required: [['get_current_problem'], ['get_current_behaviour'], ['apply_problem'], ['list_behaviours'], ['use_behaviour', 'generated-client-interviewee']],
    forbidden: ['apply_behaviour', 'apply_persona'],
  },
  {
    id: 'reuse-all',
    canAuthorBehaviour: true,
    library: reusableLibrary,
    request: 'Crea una LEIA en la que el alumno implemente en Python una función que compruebe si dos textos son anagramas, con un profesor paciente que dé pistas.',
    required: [
      ['use_problem', 'problem-python-anagrams'],
      ['use_behaviour', 'behaviour-python-coach'],
      ['use_persona', 'persona-alex-python'],
    ],
    forbidden: ['apply_problem', 'apply_behaviour', 'apply_persona'],
  },
  {
    id: 'create-problem-reuse-role-and-persona',
    canAuthorBehaviour: true,
    library: reusableLibrary,
    request: 'Crea una LEIA de programación para que el alumno implemente merge sort en Python. Quiero un profesor de Python paciente que ayude con pistas sin dar la solución.',
    required: [
      ['apply_problem'],
      ['use_behaviour', 'behaviour-python-coach'],
      ['use_persona', 'persona-alex-python'],
    ],
    forbidden: ['use_problem', 'apply_behaviour', 'apply_persona'],
  },
  {
    id: 'create-all-when-unrelated',
    canAuthorBehaviour: true,
    library: unrelatedLibrary,
    request: 'Crea una LEIA de requirements elicitation para entrevistar a una enfermera de triaje de urgencias y modelar prioridades, síntomas, constantes y derivaciones.',
    required: [['apply_problem'], ['apply_behaviour'], ['apply_persona']],
    forbidden: ['use_problem', 'use_behaviour', 'use_persona'],
  },
  {
    id: 'basic-user-cannot-create-behaviour',
    canAuthorBehaviour: false,
    library: unrelatedLibrary,
    request: 'Crea una LEIA tipo juego en la que un guía medieval plantea acertijos al alumno. No reutilices recursos que no encajen.',
    required: [['list_behaviours'], ['apply_problem']],
    forbidden: ['use_problem', 'use_behaviour', 'use_persona', 'apply_behaviour'],
    expectNoBehaviour: true,
  },
];

const clone = (value) => JSON.parse(JSON.stringify(value));

function parseArguments(call) {
  try {
    return call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return {};
  }
}

function extractCalls(response) {
  return (response.output || [])
    .filter((item) => item?.type === 'function_call')
    .map((item) => ({ callId: item.call_id || item.id, name: item.name, arguments: item.arguments }));
}

function responseText(response) {
  if (typeof response.output_text === 'string') return response.output_text.trim();
  return '';
}

function executeCalls(calls, state, library) {
  const behaviours = () => [...new Map([
    ...library.behaviours, ...state.rememberedBehaviours.values(),
  ].map(item => [item.id, item])).values()];
  if (state.behaviour) state.rememberedBehaviours.set(state.behaviour.id, clone(state.behaviour));
  const priority = {
    get_current_problem: 0,
    get_current_behaviour: 0,
    get_current_persona: 0,
    list_problems: 0,
    list_behaviours: 0,
    list_personas: 0,
    apply_problem: 10,
    use_problem: 10,
    apply_behaviour: 20,
    use_behaviour: 20,
    apply_persona: 30,
    use_persona: 30,
    set_leia_name: 40,
  };
  const ordered = [...calls].sort((a, b) => (priority[a.name] ?? 100) - (priority[b.name] ?? 100));
  const inspectedBefore = new Set(state.inspected);
  let activeProcess = state.problem?.process;

  return ordered.map((call) => {
    const args = parseArguments(call);
    let output;
    let successful = false;

    if (call.name === 'list_problems') {
      state.inspected.add('problem');
      output = library.problems;
      successful = true;
    } else if (call.name === 'list_behaviours') {
      state.inspected.add('behaviour');
      output = behaviours();
      successful = true;
    } else if (call.name === 'list_personas') {
      state.inspected.add('persona');
      output = library.personas;
      successful = true;
    } else if (call.name === 'get_current_problem') {
      output = state.problem;
      successful = true;
    } else if (call.name === 'get_current_behaviour') {
      output = state.behaviour;
      successful = true;
    } else if (call.name === 'get_current_persona') {
      output = state.persona;
      successful = true;
    } else if (call.name === 'use_problem') {
      const selected = library.problems.find((item) => item.id === args.id);
      if (selected) {
        state.problem = clone(selected);
        state.behaviour = null;
        activeProcess = selected.process;
        output = { status: 'selected', id: selected.id, name: selected.name };
        successful = true;
      } else output = { error: 'Problem id not found' };
    } else if (call.name === 'apply_problem') {
      if (!inspectedBefore.has('problem')) output = { error: 'Inspect list_problems in a previous response first.' };
      else {
        state.problem = { ...clone(args), id: 'created-problem' };
        state.behaviour = null;
        activeProcess = args.process;
        output = { status: 'applied' };
        successful = true;
      }
    } else if (call.name === 'use_behaviour') {
      const selected = behaviours().find((item) => item.id === args.id);
      const sameProcess = selected && JSON.stringify([...(selected.process || [])].sort()) === JSON.stringify([...(activeProcess || [])].sort());
      if (selected && state.problem && sameProcess) {
        state.behaviour = clone(selected);
        output = { status: 'selected', id: selected.id, name: selected.name };
        successful = true;
      } else output = { error: 'Behaviour not found or process does not match the selected Problem.' };
    } else if (call.name === 'apply_behaviour') {
      if (!inspectedBefore.has('behaviour')) output = { error: 'Inspect list_behaviours in a previous response first.' };
      else {
        state.behaviour = { ...clone(args), id: 'created-behaviour' };
        state.rememberedBehaviours.set(state.behaviour.id, clone(state.behaviour));
        output = { status: 'applied' };
        successful = true;
      }
    } else if (call.name === 'use_persona') {
      const selected = library.personas.find((item) => item.id === args.id);
      if (selected) {
        state.persona = clone(selected);
        output = { status: 'selected', id: selected.id, name: selected.name };
        successful = true;
      } else output = { error: 'Persona id not found' };
    } else if (call.name === 'apply_persona') {
      if (!inspectedBefore.has('persona')) output = { error: 'Inspect list_personas in a previous response first.' };
      else {
        state.persona = { ...clone(args), id: 'created-persona' };
        output = { status: 'applied' };
        successful = true;
      }
    } else if (call.name === 'set_leia_name') {
      state.title = args.name;
      output = { status: 'set' };
      successful = true;
    } else output = { error: `Unknown tool ${call.name}` };

    state.events.push({ name: call.name, id: args.id, successful, output });
    return {
      type: 'function_call_output',
      call_id: call.callId,
      output: JSON.stringify(output),
    };
  });
}

function evaluateScenario(scenario, state) {
  const successfulEvents = state.events.filter((event) => event.successful);
  const missing = scenario.required.filter(([name, id]) =>
    !successfulEvents.some((event) => event.name === name && (!id || event.id === id)),
  );
  const forbidden = scenario.forbidden.filter((name) =>
    state.events.some((event) => event.name === name),
  );
  const gateViolations = state.events.filter((event) =>
    !event.successful && typeof event.output?.error === 'string' && event.output.error.includes('previous response'),
  );
  const noBehaviourSatisfied = !scenario.expectNoBehaviour || state.behaviour === null;

  return {
    pass: missing.length === 0 && forbidden.length === 0 && gateViolations.length === 0 && noBehaviourSatisfied,
    missing,
    forbidden,
    gateViolations: gateViolations.map((event) => event.name),
    noBehaviourSatisfied,
  };
}

async function runScenario(client, scenario, runNumber) {
  const rawTools = buildTools(scenario.canAuthorBehaviour);
  const instructions = problemChatService.buildSystemPrompt(rawTools);
  const state = {
    inspected: new Set(),
    problem: scenario.initialSelection?.problem ? clone(scenario.initialSelection.problem) : null,
    behaviour: scenario.initialSelection?.behaviour ? clone(scenario.initialSelection.behaviour) : null,
    persona: scenario.initialSelection?.persona ? clone(scenario.initialSelection.persona) : null,
    rememberedBehaviours: new Map(),
    title: null,
    events: [],
  };

  let response = await client.responses.create({
    model,
    input: scenario.request,
    instructions,
    tools: rawTools,
    store: true,
    parallel_tool_calls: false,
    max_output_tokens: 1400,
  });
  let finalText = '';

  for (let step = 0; step < 10; step += 1) {
    const calls = extractCalls(response);
    if (calls.length === 0) {
      finalText = responseText(response);
      break;
    }
    const outputs = executeCalls(calls, state, scenario.library);
    response = await client.responses.create({
      model,
      input: outputs,
      previous_response_id: response.id,
      instructions,
      tools: rawTools,
      store: true,
      parallel_tool_calls: false,
      max_output_tokens: 1400,
    });
  }

  const evaluation = evaluateScenario(scenario, state);
  return {
    scenario: scenario.id,
    run: runNumber,
    pass: evaluation.pass,
    calls: state.events.map((event) => `${event.successful ? 'ok' : 'rejected'}:${event.name}${event.id ? `(${event.id})` : ''}`),
    selected: {
      problem: state.problem?.id || null,
      behaviour: state.behaviour?.id || null,
      persona: state.persona?.id || null,
    },
    missing: evaluation.missing,
    forbidden: evaluation.forbidden,
    gateViolations: evaluation.gateViolations,
    finalText: finalText.slice(0, 240),
  };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required in leia-runner/.env');
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const selectedScenarios = scenarioFilter
    ? scenarios.filter((scenario) => scenario.id === scenarioFilter)
    : scenarios;
  if (selectedScenarios.length === 0) {
    throw new Error(`Unknown scenario '${scenarioFilter}'`);
  }
  const results = [];
  for (let runNumber = 1; runNumber <= repeat; runNumber += 1) {
    for (const scenario of selectedScenarios) {
      const result = await runScenario(client, scenario, runNumber);
      results.push(result);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }

  const passed = results.filter((result) => result.pass).length;
  process.stdout.write(`${JSON.stringify({ summary: { model, passed, total: results.length } })}\n`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
