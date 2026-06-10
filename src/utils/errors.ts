/**
 * Gateway error taxonomy.
 *
 * ARCHITECTURAL DECISION: clients of an OpenAI-compatible gateway expect the
 * OpenAI error envelope, not Fastify/Node stack traces. Every error that can
 * reach a client is modelled as a {@link GatewayError} subclass that knows its
 * HTTP status, its OpenAI `error.type`, whether it is retryable, and how to
 * serialise itself. The error-handler middleware therefore never has to guess —
 * it calls `toOpenAIError()` and is done. Raw `Error`s that escape are treated
 * as a 500 `api_error` with the internal message redacted.
 *
 * This module lives under utils/ (not providers/) so that routes, middleware,
 * services, and providers can all depend on it without inverting the import
 * graph (the spec's tree nests ProviderError under providers/base.ts;
 * ProviderError here extends GatewayError so both shapes coexist).
 */

/** The OpenAI-compatible error envelope returned to clients. */
export interface OpenAIErrorBody {
  readonly error: {
    readonly message: string;
    readonly type: OpenAIErrorType;
    readonly param: string | null;
    readonly code: string | null;
  };
}

/** The closed set of OpenAI `error.type` discriminators we emit. */
export type OpenAIErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'server_error'
  | 'api_error';

/** Structured options shared by all gateway errors. */
export interface GatewayErrorOptions {
  /** Machine-readable short code, surfaced as OpenAI `error.code`. */
  readonly code?: string;
  /** The offending request parameter, surfaced as OpenAI `error.param`. */
  readonly param?: string;
  /** Whether the caller (or the gateway's failover loop) may retry. */
  readonly retryable?: boolean;
  /** Underlying cause, retained for logs but never serialised to the client. */
  readonly cause?: unknown;
  /** Extra structured context for logs (never serialised to the client). */
  readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * Base class for every error that can be returned to a client. Carries the HTTP
 * status and OpenAI error type so the error handler can serialise it uniformly.
 */
export class GatewayError extends Error {
  public override readonly name: string = 'GatewayError';
  public readonly statusCode: number;
  public readonly openAIType: OpenAIErrorType;
  public readonly code: string | null;
  public readonly param: string | null;
  public readonly retryable: boolean;
  public readonly context: Readonly<Record<string, unknown>> | undefined;

  public constructor(
    message: string,
    statusCode: number,
    openAIType: OpenAIErrorType,
    options: GatewayErrorOptions = {},
  ) {
    // `cause` is set via the standard Error options when provided.
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.statusCode = statusCode;
    this.openAIType = openAIType;
    this.code = options.code ?? null;
    this.param = options.param ?? null;
    this.retryable = options.retryable ?? false;
    this.context = options.context;
    // Restore prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Serialise to the OpenAI error envelope. Internal details are never leaked. */
  public toOpenAIError(): OpenAIErrorBody {
    return {
      error: {
        message: this.message,
        type: this.openAIType,
        param: this.param,
        code: this.code,
      },
    };
  }

  /**
   * Normalise an arbitrary thrown value into a GatewayError. Unknown errors
   * become a 500 with a generic message so that internal details (file paths,
   * SQL, secrets) can never leak to a client.
   */
  public static from(error: unknown): GatewayError {
    if (error instanceof GatewayError) {
      return error;
    }
    if (error instanceof Error) {
      return new InternalError('An unexpected internal error occurred.', {
        cause: error,
        context: { originalMessage: error.message, originalName: error.name },
      });
    }
    return new InternalError('An unexpected internal error occurred.', {
      context: { original: String(error) },
    });
  }
}

/** Extract a human-readable message from an arbitrary thrown value. */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}

/** 401 — missing, malformed, expired, or unknown API key. */
export class AuthenticationError extends GatewayError {
  public override readonly name = 'AuthenticationError';
  public constructor(
    message = 'Invalid authentication credentials.',
    options: GatewayErrorOptions = {},
  ) {
    super(message, 401, 'authentication_error', { code: 'invalid_api_key', ...options });
  }
}

/** 403 — authenticated but not permitted (e.g. admin-only endpoint, model not allowed). */
export class PermissionError extends GatewayError {
  public override readonly name = 'PermissionError';
  public constructor(
    message = 'You do not have permission to perform this action.',
    options: GatewayErrorOptions = {},
  ) {
    super(message, 403, 'permission_error', { code: 'permission_denied', ...options });
  }
}

/** 404 — unknown model or resource. */
export class NotFoundError extends GatewayError {
  public override readonly name = 'NotFoundError';
  public constructor(
    message = 'The requested resource was not found.',
    options: GatewayErrorOptions = {},
  ) {
    super(message, 404, 'not_found_error', { code: 'not_found', ...options });
  }
}

/** 422 — request body failed schema validation. */
export class ValidationError extends GatewayError {
  public override readonly name = 'ValidationError';
  public constructor(message = 'The request body is invalid.', options: GatewayErrorOptions = {}) {
    super(message, 422, 'invalid_request_error', { code: 'invalid_request', ...options });
  }
}

/** 413 — request body exceeded the configured maximum size. */
export class PayloadTooLargeError extends GatewayError {
  public override readonly name = 'PayloadTooLargeError';
  public constructor(message = 'Request body is too large.', options: GatewayErrorOptions = {}) {
    super(message, 413, 'invalid_request_error', { code: 'payload_too_large', ...options });
  }
}

/** 429 — rate limit exceeded. Carries the Retry-After hint (seconds). */
export class RateLimitError extends GatewayError {
  public override readonly name = 'RateLimitError';
  public readonly retryAfterSeconds: number;
  public constructor(
    message = 'Rate limit exceeded.',
    retryAfterSeconds = 1,
    options: GatewayErrorOptions = {},
  ) {
    super(message, 429, 'rate_limit_error', {
      code: 'rate_limit_exceeded',
      retryable: true,
      ...options,
    });
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

/**
 * 502/503 — an upstream provider failed. `retryable` drives the failover loop:
 * 5xx/network errors are retryable (try the next provider); a provider-reported
 * 4xx is a client error and is NOT retried.
 */
export class ProviderError extends GatewayError {
  public override readonly name = 'ProviderError';
  /** The provider whose call failed, for logs and metrics. */
  public readonly providerId: string | undefined;
  public constructor(
    message: string,
    statusCode = 502,
    options: GatewayErrorOptions & { readonly providerId?: string } = {},
  ) {
    const openAIType: OpenAIErrorType =
      statusCode >= 500 ? 'server_error' : 'invalid_request_error';
    super(message, statusCode, openAIType, {
      code: 'provider_error',
      retryable: statusCode >= 500 || statusCode === 429,
      ...options,
    });
    this.providerId = options.providerId;
  }
}

/** 504 — the upstream provider did not respond within the timeout. Retryable. */
export class UpstreamTimeoutError extends GatewayError {
  public override readonly name = 'UpstreamTimeoutError';
  public readonly providerId: string | undefined;
  public constructor(providerId?: string, options: GatewayErrorOptions = {}) {
    super('The upstream provider timed out.', 504, 'server_error', {
      code: 'upstream_timeout',
      retryable: true,
      ...options,
    });
    this.providerId = providerId;
  }
}

/** 503 — the selected provider's circuit breaker is OPEN. Retryable (try next). */
export class CircuitOpenError extends GatewayError {
  public override readonly name = 'CircuitOpenError';
  public readonly providerId: string;
  public constructor(providerId: string, options: GatewayErrorOptions = {}) {
    super(
      `Provider ${providerId} is temporarily unavailable (circuit open).`,
      503,
      'server_error',
      {
        code: 'circuit_open',
        retryable: true,
        ...options,
      },
    );
    this.providerId = providerId;
  }
}

/** 503 — every candidate provider failed or was unavailable; failover exhausted. */
export class AllProvidersFailedError extends GatewayError {
  public override readonly name = 'AllProvidersFailedError';
  public readonly attempts: number;
  public constructor(attempts: number, options: GatewayErrorOptions = {}) {
    super(
      'All upstream providers are currently unavailable. Please retry shortly.',
      503,
      'server_error',
      { code: 'all_providers_failed', retryable: true, ...options },
    );
    this.attempts = attempts;
  }
}

/** 500 — an unexpected internal error. The message shown to clients is generic. */
export class InternalError extends GatewayError {
  public override readonly name = 'InternalError';
  public constructor(
    message = 'An unexpected internal error occurred.',
    options: GatewayErrorOptions = {},
  ) {
    super(message, 500, 'api_error', { code: 'internal_error', ...options });
  }
}

/** 429 — the API key has exhausted its monthly budget (OpenAI insufficient_quota). */
export class InsufficientQuotaError extends GatewayError {
  public override readonly name = 'InsufficientQuotaError';
  public constructor(
    message = 'Monthly budget exceeded for this API key.',
    options: GatewayErrorOptions = {},
  ) {
    super(message, 429, 'rate_limit_error', { code: 'insufficient_quota', ...options });
  }
}

/** 503 — a dependency (DB/Redis) needed to serve the request is unavailable. */
export class ServiceUnavailableError extends GatewayError {
  public override readonly name = 'ServiceUnavailableError';
  public constructor(
    message = 'The service is temporarily unavailable.',
    options: GatewayErrorOptions = {},
  ) {
    super(message, 503, 'server_error', {
      code: 'service_unavailable',
      retryable: true,
      ...options,
    });
  }
}
