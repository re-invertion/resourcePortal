import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { TracingService } from "./tracing.service";

describe("TracingService", () => {
  it("continues a valid W3C traceparent and creates a new span", () => {
    const service = new TracingService({
      get: vi.fn(),
    } as unknown as ConfigService);
    const parent =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    const span = service.startServerSpan(parent, "GET /api/health");

    expect(span.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(span.parentSpanId).toBe("00f067aa0ba902b7");
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.traceparent).toBe(`00-${span.traceId}-${span.spanId}-01`);
  });

  it("creates a fresh trace when traceparent is invalid", () => {
    const service = new TracingService({
      get: vi.fn(),
    } as unknown as ConfigService);

    const span = service.startServerSpan("invalid", "POST /api/tenants");

    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.parentSpanId).toBeNull();
    expect(span.traceparent).toBe(`00-${span.traceId}-${span.spanId}-01`);
  });

  it("exports a completed server span through OTLP HTTP JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const service = new TracingService({
      get: vi.fn((key: string) =>
        key === "OTEL_EXPORTER_OTLP_ENDPOINT"
          ? "http://otel-collector:4318"
          : key === "OTEL_SERVICE_NAME"
            ? "resource-portal-api"
            : undefined,
      ),
    } as unknown as ConfigService);
    const span = service.startServerSpan(undefined, "GET /api/metrics");

    await service.finishServerSpan(span, {
      method: "GET",
      route: "/api/metrics",
      statusCode: 200,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://otel-collector:4318/v1/traces",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    vi.unstubAllGlobals();
  });
});
