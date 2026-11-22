import { describe, expect, test } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizeTools } = require('../utils/problemChatTools');

describe('problem-chat tools', () => {
  test('preserves strict JSON Schema tools', () => {
    expect(normalizeTools([{
      name: 'apply_rubric',
      description: 'Apply a rubric',
      strict: true,
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    }])).toEqual([{
      type: 'function',
      name: 'apply_rubric',
      description: 'Apply a rubric',
      strict: true,
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    }]);
  });

  test('omits strict unless explicitly enabled', () => {
    expect(normalizeTools([{ name: 'read', parameters: {} }])[0]).not.toHaveProperty('strict');
  });

  test('removes unsupported keywords recursively from strict schemas only', () => {
    const parameters = {
      $id: 'rubric',
      type: 'object',
      properties: {
        levels: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
      },
    };
    const strict = normalizeTools([{ name: 'apply_rubric', strict: true, parameters }])[0].parameters;
    expect(strict).toEqual({
      type: 'object',
      properties: { levels: { type: 'array', minItems: 1, items: { type: 'string' } } },
    });
    expect(parameters.properties.levels.uniqueItems).toBe(true);
    expect(normalizeTools([{ name: 'local', parameters }])[0].parameters).toBe(parameters);
  });

  test('ensures optional properties are added to required in strict additionalProperties:false objects', () => {
    const parameters = {
      type: 'object',
      additionalProperties: false,
      required: ['sections'],
      properties: {
        evaluationPrompt: { type: 'string' },
        sections: { type: 'array', items: { type: 'string' } },
      },
    };
    const strict = normalizeTools([{ name: 'apply_rubric', strict: true, parameters }])[0].parameters;
    expect(strict.required).toEqual(['sections', 'evaluationPrompt']);
  });
});
