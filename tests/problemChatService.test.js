import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const problemChatService = require('../services/problemChatService');

describe('problem chat authoring instructions', () => {
  it('requires library lookup before creating resources', () => {
    const prompt = problemChatService.buildSystemPrompt([
      { name: 'list_problems' },
      { name: 'list_behaviours' },
      { name: 'list_personas' },
      { name: 'apply_behaviour' },
    ]);

    expect(prompt).toContain('Mandatory reuse-first workflow');
    expect(prompt).toContain('Before creating a Problem, call list_problems');
    expect(prompt).toContain('After the final Problem is selected or created, call list_behaviours');
    expect(prompt).toContain('Before creating a Persona, call list_personas');
  });

  it('forbids base Behaviour authoring when apply_behaviour is unavailable', () => {
    const prompt = problemChatService.buildSystemPrompt([
      { name: 'list_behaviours' },
      { name: 'use_behaviour' },
    ]);

    expect(prompt).toContain('You cannot author or edit the base Behaviour resource');
    expect(prompt).toContain('You may still use extends, overrides or constrainedTo');
  });

  it('omits rubric instructions when apply_rubric is not enabled and includes them when enabled', () => {
    const withoutRubric = problemChatService.buildSystemPrompt([
      { name: 'list_problems' },
      { name: 'list_behaviours' },
      { name: 'list_personas' },
    ]);
    expect(withoutRubric).toContain('made of three resources');
    expect(withoutRubric).not.toContain('apply_rubric');

    const withRubric = problemChatService.buildSystemPrompt([
      { name: 'list_problems' },
      { name: 'list_behaviours' },
      { name: 'list_personas' },
      { name: 'apply_rubric' },
    ]);
    expect(withRubric).toContain('made of four resources');
    expect(withRubric).toContain('apply_rubric');
    expect(withRubric).toContain('{{rubric.criteria}}');
  });
});
