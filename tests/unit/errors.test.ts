import {
  RoundtableError,
  ProviderError,
  WorkspaceError,
  ConfigurationError,
  ValidationError,
} from '../../src/errors';

describe('RoundtableError', () => {
  it('sets message and name', () => {
    const err = new RoundtableError('something failed');
    expect(err.message).toBe('something failed');
    expect(err.name).toBe('RoundtableError');
  });

  it('is an instance of Error', () => {
    expect(new RoundtableError('x')).toBeInstanceOf(Error);
  });

  it('stores cause when provided', () => {
    const cause = new Error('root cause');
    const err = new RoundtableError('wrapper', cause);
    expect(err.cause).toBe(cause);
  });

  it('cause is undefined when not provided', () => {
    const err = new RoundtableError('no cause');
    expect(err.cause).toBeUndefined();
  });

  it('is catchable as RoundtableError', () => {
    expect(() => { throw new RoundtableError('test'); }).toThrow(RoundtableError);
  });
});

describe('ProviderError', () => {
  it('sets message, name, and statusCode', () => {
    const err = new ProviderError('api error', 429);
    expect(err.message).toBe('api error');
    expect(err.name).toBe('ProviderError');
    expect(err.statusCode).toBe(429);
  });

  it('statusCode is undefined when not provided', () => {
    const err = new ProviderError('no status');
    expect(err.statusCode).toBeUndefined();
  });

  it('is an instance of RoundtableError and Error', () => {
    const err = new ProviderError('x');
    expect(err).toBeInstanceOf(RoundtableError);
    expect(err).toBeInstanceOf(Error);
  });

  it('stores cause', () => {
    const cause = new Error('net');
    const err = new ProviderError('wrapper', 500, cause);
    expect(err.cause).toBe(cause);
  });
});

describe('WorkspaceError', () => {
  it('sets message and name', () => {
    const err = new WorkspaceError('no folder');
    expect(err.message).toBe('no folder');
    expect(err.name).toBe('WorkspaceError');
  });

  it('is an instance of RoundtableError', () => {
    expect(new WorkspaceError('x')).toBeInstanceOf(RoundtableError);
  });

  it('stores cause', () => {
    const cause = new Error('fs');
    const err = new WorkspaceError('read fail', cause);
    expect(err.cause).toBe(cause);
  });
});

describe('ConfigurationError', () => {
  it('sets message and name', () => {
    const err = new ConfigurationError('missing key');
    expect(err.message).toBe('missing key');
    expect(err.name).toBe('ConfigurationError');
  });

  it('is an instance of RoundtableError', () => {
    expect(new ConfigurationError('x')).toBeInstanceOf(RoundtableError);
  });
});

describe('ValidationError', () => {
  it('sets message and name', () => {
    const err = new ValidationError('bad input');
    expect(err.message).toBe('bad input');
    expect(err.name).toBe('ValidationError');
  });

  it('is an instance of RoundtableError', () => {
    expect(new ValidationError('x')).toBeInstanceOf(RoundtableError);
  });

  it('is catchable as ValidationError', () => {
    expect(() => { throw new ValidationError('test'); }).toThrow(ValidationError);
  });
});
