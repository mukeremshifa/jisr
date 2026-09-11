/** Errors carry a stable `code` so callers branch on the code, never on a message string. */
export class JisrError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'JisrError';
  }
}

export class ConfigError extends JisrError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('config_error', message, details);
    this.name = 'ConfigError';
  }
}

/** A dependency is not configured. The caller must degrade visibly, never pretend. */
export class NotConfiguredError extends JisrError {
  constructor(what: string) {
    super('not_configured', `${what} is not configured`, { what });
    this.name = 'NotConfiguredError';
  }
}

export class ValidationError extends JisrError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation_error', message, details);
    this.name = 'ValidationError';
  }
}

export class ForbiddenError extends JisrError {
  constructor(message = 'forbidden', details?: Record<string, unknown>) {
    super('forbidden', message, details);
    this.name = 'ForbiddenError';
  }
}

/** Every model call that cannot be repaired ends here, and the case goes to a human. */
export class ModelUnavailableError extends JisrError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('model_unavailable', message, details);
    this.name = 'ModelUnavailableError';
  }
}
