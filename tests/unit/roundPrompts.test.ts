import { RoundType } from '../../src/types';
import {
  ROUND_SYSTEM_PROMPTS,
  ROUND_LABELS,
  buildSystemPrompt,
  buildSubAgentVerificationPrompt,
  buildReflectionPrompt,
} from '../../src/prompts/roundPrompts';

const ALL_ROUND_TYPES = Object.values(RoundType);

describe('ROUND_SYSTEM_PROMPTS', () => {
  it('has an entry for every RoundType', () => {
    for (const roundType of ALL_ROUND_TYPES) {
      expect(ROUND_SYSTEM_PROMPTS[roundType]).toBeDefined();
    }
  });

  it.each(ALL_ROUND_TYPES)('system prompt for %s is a non-empty string', (roundType) => {
    const prompt = ROUND_SYSTEM_PROMPTS[roundType];
    expect(typeof prompt).toBe('string');
    expect(prompt.trim().length).toBeGreaterThan(50);
  });
});


describe('ROUND_LABELS', () => {
  it('has a label for every RoundType', () => {
    for (const roundType of ALL_ROUND_TYPES) {
      const label = ROUND_LABELS[roundType];
      expect(typeof label).toBe('string');
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('buildSystemPrompt', () => {
  it.each(ALL_ROUND_TYPES)('returns a non-empty string for %s', (roundType) => {
    const result = buildSystemPrompt(roundType);
    expect(typeof result).toBe('string');
    expect(result.trim().length).toBeGreaterThan(100);
  });

  it('includes the role description for the given round type', () => {
    const result = buildSystemPrompt(RoundType.DEVELOPER);
    expect(result).toContain(ROUND_SYSTEM_PROMPTS[RoundType.DEVELOPER]);
  });

  it('includes the preamble for all round types', () => {
    const result = buildSystemPrompt(RoundType.QA);
    expect(result).toContain('AI participant in a software development roundtable');
  });
});

describe('buildSubAgentVerificationPrompt', () => {
  const mainResponse = 'This is the main agent initial response.';

  it('includes the main agent response verbatim', () => {
    const result = buildSubAgentVerificationPrompt(RoundType.REVIEWER, mainResponse);
    expect(result).toContain(mainResponse);
  });

  it('includes verification instructions', () => {
    const result = buildSubAgentVerificationPrompt(RoundType.REVIEWER, mainResponse);
    expect(result).toContain('verify');
  });

  it('includes the role description for the given round type', () => {
    const result = buildSubAgentVerificationPrompt(RoundType.ARCHITECT, mainResponse);
    expect(result).toContain(ROUND_SYSTEM_PROMPTS[RoundType.ARCHITECT]);
  });

  it.each(ALL_ROUND_TYPES)('returns a non-empty string for %s', (roundType) => {
    const result = buildSubAgentVerificationPrompt(roundType, mainResponse);
    expect(typeof result).toBe('string');
    expect(result.trim().length).toBeGreaterThan(100);
  });
});

describe('buildReflectionPrompt', () => {
  const mainResponse = 'Initial response from the main agent.';
  const feedbacks = [
    { agentName: 'claude', feedback: 'You missed error handling.' },
    { agentName: 'gpt', feedback: 'Consider adding rate limiting.' },
  ];

  it('includes the main agent response', () => {
    const result = buildReflectionPrompt(mainResponse, feedbacks);
    expect(result).toContain(mainResponse);
  });

  it('includes all sub-agent feedback entries', () => {
    const result = buildReflectionPrompt(mainResponse, feedbacks);
    for (const { feedback } of feedbacks) {
      expect(result).toContain(feedback);
    }
  });

  it('includes all agent names in feedback sections', () => {
    const result = buildReflectionPrompt(mainResponse, feedbacks);
    for (const { agentName } of feedbacks) {
      expect(result).toContain(agentName.toUpperCase());
    }
  });

  it('returns an empty feedback section when no feedbacks provided', () => {
    const result = buildReflectionPrompt(mainResponse, []);
    expect(typeof result).toBe('string');
    expect(result).toContain(mainResponse);
  });

  it('produces a self-contained final response instruction', () => {
    const result = buildReflectionPrompt(mainResponse, feedbacks);
    expect(result).toContain('FINAL refined response');
  });
});
