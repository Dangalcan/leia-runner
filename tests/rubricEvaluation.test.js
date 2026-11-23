import { describe, expect, test } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  resolveRubricEvaluationPrompt,
  buildRubricEvaluationPrompt,
  scoreAndNormalizeRubricEvaluation,
} = require('../utils/rubricEvaluation');

const sampleRubric = {
  apiVersion: 'v1',
  metadata: { name: 'Software Design Rubric' },
  spec: {
    evaluationPrompt:
      'Review conversation:\n{{currentStage.outputs.conversation}}\nAnd previous draft:\n{{previousStage.outputs.submitedSolution}}',
    sections: [
      {
        title: 'Technical Accuracy',
        weight: 60,
        levels: ['Unsatisfactory', 'Developing', 'Proficient', 'Exemplary'],
        criteria: [
          {
            name: 'Model correctness',
            descriptors: [
              { level: 'Unsatisfactory', description: 'Wrong' },
              { level: 'Developing', description: 'Partial' },
              { level: 'Proficient', description: 'Mostly right' },
              { level: 'Exemplary', description: 'Fully right' },
            ],
          },
          {
            name: 'Edge cases',
            descriptors: [
              { level: 'Unsatisfactory', description: 'Ignored' },
              { level: 'Developing', description: 'Some' },
              { level: 'Proficient', description: 'Most' },
              { level: 'Exemplary', description: 'All' },
            ],
          },
        ],
      },
      {
        title: 'Communication',
        weight: 40,
        levels: ['Weak', 'Strong'],
        criteria: [
          {
            name: 'Justification',
            descriptors: [
              { level: 'Weak', description: 'No reasons' },
              { level: 'Strong', description: 'Clear reasons' },
            ],
          },
        ],
      },
    ],
  },
};

describe('rubric evaluation utilities', () => {
  test('resolves currentStage and previousStage placeholders safely', () => {
    const { resolved, referenced } = resolveRubricEvaluationPrompt(
      sampleRubric.spec.evaluationPrompt,
      {
        currentStage: {
          outputs: {
            conversation: [
              { role: 'participant', text: 'Hello client' },
              { role: 'agent', speaker: 'Marta', text: 'Hi, let us discuss requirements' },
            ],
          },
        },
        previousStage: {
          outputs: {
            submitedSolution: 'class Diagram {}',
          },
        },
      },
    );

    expect(referenced.has('currentStage.conversation')).toBe(true);
    expect(referenced.has('previousStage.submitedSolution')).toBe(true);
    expect(resolved).toContain('[Participant]: Hello client');
    expect(resolved).toContain('[Marta]: Hi, let us discuss requirements');
    expect(resolved).toContain('class Diagram {}');
    expect(resolved).toContain('BEGIN PARTICIPANT CONVERSATION DATA');
  });

  test('builds prompt with language and fallback unreferenced submitted solution', () => {
    const prompt = buildRubricEvaluationPrompt({
      rubric: sampleRubric,
      context: {
        currentStage: {
          outputs: {
            conversation: [{ role: 'participant', text: 'Question 1' }],
            submitedSolution: 'Final answer',
          },
        },
      },
      language: 'es',
    });

    expect(prompt).toContain('Software Design Rubric');
    expect(prompt).toContain('Final answer');
    expect(prompt).toContain('language: "es"');
  });

  test('deterministically computes 0-10 weighted score and Markdown breakdown', () => {
    // Section 1 (60%): levels 0..3 -> Developing=1/3*10=3.33, Exemplary=3/3*10=10 -> avg=6.665 -> 60% = 3.999
    // Section 2 (40%): levels 0..1 -> Strong=1/1*10=10 -> avg=10 -> 40% = 4.0
    // Total = 7.999 -> rounded to 8
    const result = scoreAndNormalizeRubricEvaluation(sampleRubric, {
      summary: 'Good reasoning overall.',
      sections: [
        {
          title: 'Technical Accuracy',
          criteria: [
            { name: 'Model correctness', selectedLevel: 'Exemplary', justification: 'Spot on.' },
            { name: 'Edge cases', selectedLevel: 'Developing', justification: 'Missed nulls.' },
          ],
        },
        {
          title: 'Communication',
          criteria: [
            { name: 'Justification', selectedLevel: 'Strong', justification: 'Clear rationale.' },
          ],
        },
      ],
    });

    expect(result.evaluationMode).toBe('rubric');
    expect(result.score).toBe(8);
    expect(result.rubricEvaluation.scale).toBe(10);
    expect(result.rubricEvaluation.totalScore).toBe(8);
    expect(result.rubricEvaluation.sections[0].score).toBe(6.67);
    expect(result.rubricEvaluation.sections[1].score).toBe(10);
    expect(result.evaluation).toContain('## Software Design Rubric — 8/10');
    expect(result.evaluation).toContain('| Model correctness | Exemplary | 10/10 | Spot on. |');
  });

  test('rejects invalid level returned by the model', () => {
    expect(() =>
      scoreAndNormalizeRubricEvaluation(sampleRubric, {
        summary: 'Bad level',
        sections: [
          {
            title: 'Technical Accuracy',
            criteria: [
              { name: 'Model correctness', selectedLevel: 'InventedLevel', justification: 'x' },
              { name: 'Edge cases', selectedLevel: 'Developing', justification: 'y' },
            ],
          },
          {
            title: 'Communication',
            criteria: [{ name: 'Justification', selectedLevel: 'Strong', justification: 'z' }],
          },
        ],
      }),
    ).toThrow(/Invalid level "InventedLevel"/);
  });
});
