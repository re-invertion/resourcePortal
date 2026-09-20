import { Logger } from "@nestjs/common";

export type StructuredLogLevel = "log" | "warn" | "error";

export function structuredLog(
  logger: Logger,
  level: StructuredLogLevel,
  service: string,
  event: string,
  fields: Record<string, unknown> = {},
) {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    service,
    event,
    ...fields,
  });
  logger[level](payload);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function operationCorrelationId(input: unknown, operationId: string) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const value = (input as Record<string, unknown>).correlationId;
    if (typeof value === "string" && value.length > 0 && value.length <= 128) {
      return value;
    }
  }
  return operationId;
}
