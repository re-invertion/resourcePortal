const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 300_000;

const RETRYABLE_ERROR_CODES = new Set([
  "PlatformUnavailable",
  "InsufficientCapacity",
  "CertificateObservationFailed",
  "DnsResolverUnavailable",
  "NetworkUnavailable",
  "StorageBackendUnavailable",
]);

export function computeRetryDelayMs(
  attempt: number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
) {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const delay = baseDelayMs * 2 ** (normalizedAttempt - 1);
  return Math.min(delay, maxDelayMs);
}

export function isRetryableOperationError(error: unknown) {
  const shape = errorShape(error);
  if (shape.retryable !== undefined) {
    return shape.retryable;
  }

  return shape.code !== undefined && RETRYABLE_ERROR_CODES.has(shape.code);
}

export function operationErrorCode(error: unknown) {
  return errorShape(error).code ?? "OperationExecutionFailed";
}

export function operationErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  const shape = errorShape(error);
  return shape.message ?? String(error);
}

function errorShape(error: unknown): {
  code?: string;
  message?: string;
  retryable?: boolean;
} {
  if (!isRecord(error)) {
    return {};
  }

  const direct = pickErrorShape(error);
  if (direct.code !== undefined || direct.retryable !== undefined) {
    return direct;
  }

  const response = error.response;
  if (isRecord(response)) {
    return {
      ...direct,
      ...pickErrorShape(response),
    };
  }

  return direct;
}

function pickErrorShape(value: Record<string, unknown>) {
  return {
    code: typeof value.code === "string" ? value.code : undefined,
    message: typeof value.message === "string" ? value.message : undefined,
    retryable:
      typeof value.retryable === "boolean" ? value.retryable : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
