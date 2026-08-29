import { describe, expect, it } from "vitest";
import { ObservabilityService } from "./observability.service";

describe("ObservabilityService", () => {
  it("renders Prometheus metrics for recorded requests", () => {
    const service = new ObservabilityService();

    service.recordRequest({
      durationMs: 42,
      method: "GET",
      route: "/api/health",
      statusCode: 200,
    });

    const metrics = service.renderPrometheusMetrics();

    expect(metrics).toContain("resource_portal_up 1");
    expect(metrics).toContain(
      'resource_portal_http_requests_total{method="GET",route="/api/health",status_code="200"} 1',
    );
    expect(metrics).toContain(
      'resource_portal_http_request_duration_ms_bucket{method="GET",route="/api/health",status_code="200",le="50"} 1',
    );
  });
});
