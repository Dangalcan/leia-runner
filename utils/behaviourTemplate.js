// Runtime references shared by the one-shot generator and conversation flow.
const CORE_PLACEHOLDERS = [
  '{{problem.details}}',
  '{{problem.description}}',
  '{{persona.personality}}',
  '{{persona.fullName}}',
  '{{persona.description}}',
  '{{problem.personaBackground}}',
  '{{problem.solution}}',
  '{{behaviour.role}}',
];

module.exports = { CORE_PLACEHOLDERS };
