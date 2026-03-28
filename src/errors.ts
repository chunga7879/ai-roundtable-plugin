/**
 * Typed error hierarchy for the AI Roundtable extension.
 * All errors extend RoundtableError so callers can catch the entire family.
 */

export class RoundtableError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RoundtableError';
    // Restore prototype chain (required for extending built-in Error in TS)
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ProviderError extends RoundtableError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = 'ProviderError';
  }
}

export class WorkspaceError extends RoundtableError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'WorkspaceError';
  }
}

export class ConfigurationError extends RoundtableError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'ConfigurationError';
  }
}

export class ValidationError extends RoundtableError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'ValidationError';
  }
}
