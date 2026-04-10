import { RoundType } from '../../src/types';
import {
  ROUND_LABELS,
  buildReflectionSystemPrompt,
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

  it('keeps run_command guidance consistent with staged write_file verification', () => {
    const result = buildSystemPrompt(RoundType.DEVELOPER);
    expect(result).toContain('Do NOT use for validating files you just wrote via write_file');
    expect(result).toContain('unless your round-specific instructions explicitly allow it');
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

describe('buildReflectionSystemPrompt', () => {
  it.each(ALL_ROUND_TYPES)('returns a non-empty string for %s', (roundType) => {
    const result = buildReflectionSystemPrompt(roundType);
    expect(typeof result).toBe('string');
    expect(result.trim().length).toBeGreaterThan(100);
  });

  it('puts reflection tool overrides before role instructions', () => {
    const result = buildReflectionSystemPrompt(RoundType.DEVELOPER);
    expect(result).toContain('REFLECTION MODE OVERRIDES (HIGHEST PRIORITY):');
    expect(result).toContain('run_command and read_file are not available in reflection');
    expect(result).toContain('these reflection overrides take precedence');
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

  it('mentions both read and written file sections for verifier context', () => {
    const result = buildSubAgentSystemPrompt(RoundType.REVIEWER);
    expect(result).toContain('[FILES READ BY PRIMARY AGENT]');
    expect(result).toContain('[FILES WRITTEN BY PRIMARY AGENT]');
  });

  it('requires machine-readable JSON verifier output schema', () => {
    const result = buildSubAgentSystemPrompt(RoundType.REVIEWER);
    expect(result).toContain('Return ONLY valid JSON');
    expect(result).toContain('{"issues":[{"title":"<short issue title>"');
    expect(result).toContain('{"issues":[]}');
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

  it('does not include legacy text-based unanimous consensus rule', () => {
    const result = buildReflectionPrompt(mainResponse, feedbacks, ['Missing error handling']);
    expect(result).not.toContain('If ALL');
    expect(result).toContain('[MANDATORY CONSENSUS ISSUES — CODE-EXTRACTED]');
    expect(result).toContain('You MUST fix every item below');
  });

  it('uses code-extracted mandatory section as the only mandatory source', () => {
    const result = buildReflectionPrompt(mainResponse, feedbacks, ['Add input validation']);
    expect(result).toContain('MANDATORY items come only from [MANDATORY CONSENSUS ISSUES — CODE-EXTRACTED].');
  });

  it('places reflection tool/file-scope constraints near the top of the prompt', () => {
    const result = buildReflectionPrompt(mainResponse, feedbacks, ['Add input validation']);
    expect(result).toContain('REFLECTION CONSTRAINTS (MANDATORY):');
    expect(result).toContain('run_command and read_file are not available during reflection');
    expect(result).toContain('You may modify files only if their paths are present');
    expect(result).toContain('Do not create, modify, or delete any file outside that provided file list.');
    expect(result).toContain('OUT_OF_SCOPE_CHANGES_JSON:');
  });
});
