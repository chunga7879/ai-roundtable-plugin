import { RoundType } from '../../src/types';
import {
  ROUND_LABELS,
  buildSystemPrompt,
  buildSubAgentSystemPrompt,
  buildSubAgentUserMessage,
  buildReflectionPrompt,
} from '../../src/prompts/roundPrompts';

const ALL_ROUND_TYPES = Object.values(RoundType);

describe('buildSystemPrompt', () => {
  it.each(ALL_ROUND_TYPES)('returns a non-empty string for %s', (roundType) => {
    const result = buildSystemPrompt(roundType);
    expect(typeof result).toBe('string');
    expect(result.trim().length).toBeGreaterThan(100);
  });

  it('includes the preamble for all round types', () => {
    const result = buildSystemPrompt(RoundType.QA);
    expect(result).toContain('AI participant in a software development roundtable');
  });

  it('includes expertise content for the given round type', () => {
    const result = buildSystemPrompt(RoundType.DEVELOPER);
    expect(result).toContain('Principal Software Engineer');
  });

  it('includes output format instructions for the given round type', () => {
    const result = buildSystemPrompt(RoundType.DEVELOPER);
    expect(result).toContain('Definition of Done');
  });

  it('includes expertise and output format for ARCHITECT', () => {
    const result = buildSystemPrompt(RoundType.ARCHITECT);
    expect(result).toContain('Distinguished Software Architect');
    expect(result).toContain('docs/architecture.md');
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

describe('buildSubAgentVerificationPrompt', () => {
  const mainResponse = 'This is the main agent initial response.';

  // buildSubAgentSystemPrompt — verifier role + expertise (no data)
  it('includes verification instructions', () => {
    const result = buildSubAgentSystemPrompt(RoundType.REVIEWER);
    expect(result).toContain('verify');
  });

  it('includes role expertise content for the given round type', () => {
    const result = buildSubAgentSystemPrompt(RoundType.ARCHITECT);
    expect(result).toContain('Distinguished Software Architect');
  });

  it('does NOT include output format directives (write_file instructions)', () => {
    const result = buildSubAgentSystemPrompt(RoundType.DEVELOPER);
    expect(result).not.toContain('Definition of Done');
    expect(result).not.toContain('OUTPUT FORMAT — MANDATORY');
  });

  it('explicitly states tool access is unavailable', () => {
    const result = buildSubAgentSystemPrompt(RoundType.REVIEWER);
    expect(result).toContain('do not have tool access');
  });

  it('does NOT embed the primary agent response (that belongs in user message)', () => {
    const result = buildSubAgentSystemPrompt(RoundType.DEVELOPER);
    expect(result).not.toContain(mainResponse);
  });

  it.each(ALL_ROUND_TYPES)('system prompt returns a non-empty string for %s', (roundType) => {
    const result = buildSubAgentSystemPrompt(roundType);
    expect(typeof result).toBe('string');
    expect(result.trim().length).toBeGreaterThan(100);
  });

  // buildSubAgentUserMessage — primary response lives here as data
  it('includes the main agent response in the user message', () => {
    const result = buildSubAgentUserMessage(mainResponse, '', 'verify this');
    expect(result).toContain(mainResponse);
  });

  it('includes context sections in the user message when provided', () => {
    const result = buildSubAgentUserMessage(mainResponse, '[FILES READ BY PRIMARY AGENT]\nsome file', 'verify this');
    expect(result).toContain('[FILES READ BY PRIMARY AGENT]');
  });

  it('includes the base message in the user message', () => {
    const result = buildSubAgentUserMessage(mainResponse, '', 'Current request: add auth');
    expect(result).toContain('Current request: add auth');
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
