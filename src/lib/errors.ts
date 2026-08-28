/**
 * Application errors carry the HTTP status and a stable machine code, so the
 * error handler never has to guess and callers can branch on `code` rather
 * than on a message string that is free to change.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** `false` marks a bug rather than an expected condition; those get alerted on. */
  readonly isOperational: boolean;

  constructor(
    message: string,
    opts: { status?: number; code?: string; details?: unknown; isOperational?: boolean; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.status = opts.status ?? 500;
    this.code = opts.code ?? "internal_error";
    this.details = opts.details;
    this.isOperational = opts.isOperational ?? true;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown, message = "The request body failed validation.") {
    super(message, { status: 422, code: "validation_failed", details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Missing or invalid API key.") {
    super(message, { status: 401, code: "unauthorized" });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found.") {
    super(message, { status: 404, code: "not_found" });
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource already exists.") {
    super(message, { status: 409, code: "conflict" });
  }
}
