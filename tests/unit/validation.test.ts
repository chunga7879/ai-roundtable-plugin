import {
  validateSendMessagePayload,
  validateApplyChangesPayload,
  RoundType,
  AgentName,
} from '../../src/types';
import { ValidationError } from '../../src/errors';

// ── validateSendMessagePayload ────────────────────────────────────────────────

describe('validateSendMessagePayload', () => {
  const validPayload = {
    userMessage: 'add error handling',
    roundType: RoundType.DEVELOPER,
    mainAgent: AgentName.CLAUDE,
    subAgents: [AgentName.GPT],
  };

  it('returns parsed payload for valid input', () => {
    const result = validateSendMessagePayload(validPayload);
    expect(result.userMessage).toBe('add error handling');
    expect(result.roundType).toBe(RoundType.DEVELOPER);
    expect(result.mainAgent).toBe(AgentName.CLAUDE);
    expect(result.subAgents).toEqual([AgentName.GPT]);
  });

  it('trims whitespace from userMessage', () => {
    const result = validateSendMessagePayload({ ...validPayload, userMessage: '  hello  ' });
    expect(result.userMessage).toBe('hello');
  });

  it('accepts empty subAgents array', () => {
    const result = validateSendMessagePayload({ ...validPayload, subAgents: [] });
    expect(result.subAgents).toEqual([]);
  });

  it('accepts all valid RoundType values', () => {
    for (const rt of Object.values(RoundType)) {
      expect(() => validateSendMessagePayload({ ...validPayload, roundType: rt })).not.toThrow();
    }
  });

  it('accepts all valid AgentName values as mainAgent', () => {
    for (const a of Object.values(AgentName)) {
      expect(() => validateSendMessagePayload({ ...validPayload, mainAgent: a })).not.toThrow();
    }
  });

  it('throws ValidationError when payload is null', () => {
    expect(() => validateSendMessagePayload(null)).toThrow(ValidationError);
  });

  it('throws ValidationError when payload is a string', () => {
    expect(() => validateSendMessagePayload('bad')).toThrow(ValidationError);
  });

  it('throws ValidationError when userMessage is empty', () => {
    expect(() => validateSendMessagePayload({ ...validPayload, userMessage: '' }))
      .toThrow(ValidationError);
  });

  it('throws ValidationError when userMessage is only whitespace', () => {
    expect(() => validateSendMessagePayload({ ...validPayload, userMessage: '   ' }))
      .toThrow(ValidationError);
  });

  it('throws ValidationError when userMessage is not a string', () => {
    expect(() => validateSendMessagePayload({ ...validPayload, userMessage: 42 }))
      .toThrow(ValidationError);
  });

  it('throws ValidationError when userMessage exceeds max length', () => {
    const long = 'a'.repeat(33_000);
    expect(() => validateSendMessagePayload({ ...validPayload, userMessage: long }))
      .toThrow(ValidationError);
  });

  it('throws ValidationError for invalid roundType', () => {
    expect(() => validateSendMessagePayload({ ...validPayload, roundType: 'invalid' }))
      .toThrow(ValidationError);
  });

  it('throws ValidationError for invalid mainAgent', () => {
    expect(() => validateSendMessagePayload({ ...validPayload, mainAgent: 'unknown_bot' }))
      .toThrow(ValidationError);
  });

  it('throws ValidationError when subAgents is not an array', () => {
    expect(() => validateSendMessagePayload({ ...validPayload, subAgents: 'gpt' }))
      .toThrow(ValidationError);
  });

  it('throws ValidationError for invalid value in subAgents array', () => {
    expect(() => validateSendMessagePayload({ ...validPayload, subAgents: ['invalid_agent'] }))
      .toThrow(ValidationError);
  });

  it('throws ValidationError for non-string value in subAgents array', () => {
    expect(() => validateSendMessagePayload({ ...validPayload, subAgents: [42] }))
      .toThrow(ValidationError);
  });
});

// ── validateApplyChangesPayload ───────────────────────────────────────────────

describe('validateApplyChangesPayload', () => {
  const validChange = { filePath: 'src/index.ts', content: 'const x = 1;', isNew: false };

  it('returns payload for valid input', () => {
    const result = validateApplyChangesPayload({ fileChanges: [validChange] });
    expect(result.fileChanges).toHaveLength(1);
    expect(result.fileChanges[0].filePath).toBe('src/index.ts');
  });

  it('accepts empty fileChanges array', () => {
    const result = validateApplyChangesPayload({ fileChanges: [] });
    expect(result.fileChanges).toEqual([]);
  });

  it('accepts isNew: true', () => {
    expect(() =>
      validateApplyChangesPayload({ fileChanges: [{ ...validChange, isNew: true }] })
    ).not.toThrow();
  });

  it('throws ValidationError when payload is null', () => {
    expect(() => validateApplyChangesPayload(null)).toThrow(ValidationError);
  });

  it('throws ValidationError when payload is not an object', () => {
    expect(() => validateApplyChangesPayload('bad')).toThrow(ValidationError);
  });

  it('throws ValidationError when fileChanges is not an array', () => {
    expect(() => validateApplyChangesPayload({ fileChanges: 'not array' }))
      .toThrow(ValidationError);
  });

  it('throws ValidationError when a fileChange is not an object', () => {
    expect(() => validateApplyChangesPayload({ fileChanges: ['string item'] }))
      .toThrow(ValidationError);
  });

  it('throws ValidationError when filePath is empty', () => {
    expect(() =>
      validateApplyChangesPayload({ fileChanges: [{ ...validChange, filePath: '' }] })
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when filePath contains ..', () => {
    expect(() =>
      validateApplyChangesPayload({ fileChanges: [{ ...validChange, filePath: '../../etc/passwd' }] })
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when content is not a string', () => {
    expect(() =>
      validateApplyChangesPayload({ fileChanges: [{ ...validChange, content: 42 }] })
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when isNew is not a boolean', () => {
    expect(() =>
      validateApplyChangesPayload({ fileChanges: [{ ...validChange, isNew: 'yes' }] })
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when filePath is not a string', () => {
    expect(() =>
      validateApplyChangesPayload({ fileChanges: [{ ...validChange, filePath: 123 }] })
    ).toThrow(ValidationError);
  });
});
