export const ERROR_CODES = [
  "validation_failed",
  "not_found",
  "unauthorized",
  "forbidden",
  "conflict",
  "rate_limited",
  "provider_error",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS: Record<ErrorCode, number> = {
  validation_failed: 422,
  not_found: 404,
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
  rate_limited: 429,
  provider_error: 502,
  internal: 500,
};

/**
 * The one error type crossing module boundaries. API layers map it to the
 * consistent envelope { error: { code, message, details? } }.
 */
export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BridgeError";
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}
