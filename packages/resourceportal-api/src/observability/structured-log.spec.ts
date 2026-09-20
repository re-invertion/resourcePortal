import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { operationCorrelationId, structuredLog } from "./structured-log";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("structured logging", () => {
  it("uses Operation input correlationId and falls back to operationId", () => {
    expect(
      operationCorrelationId({ correlationId: "corr-123" }, "operation-1"),
    ).toBe("corr-123");
    expect(operationCorrelationId({}, "operation-1")).toBe("operation-1");
  });

  it("emits JSON with service, event and supplied correlation fields", () => {
    const log = vi.fn<(message: string) => void>();
    const logger = { log } as unknown as Logger;
    structuredLog(logger, "log", "resource-portal-api", "http.request", {
      requestId: "req-1",
      correlationId: "corr-1",
    });

    const raw = log.mock.calls[0]?.[0];
    if (!raw) throw new Error("Expected structured log message");
    const payload: unknown = JSON.parse(raw);
    if (!isRecord(payload)) throw new Error("Expected structured log object");

    expect(payload).toMatchObject({
      service: "resource-portal-api",
      event: "http.request",
      requestId: "req-1",
      correlationId: "corr-1",
    });
    expect(typeof payload.timestamp).toBe("string");
  });
});
