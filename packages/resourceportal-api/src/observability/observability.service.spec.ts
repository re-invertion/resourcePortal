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

  it("renders worker lifecycle counters", () => {
    const service = new ObservabilityService();

    service.recordWorkerEvent("poll", "worker-1");
    service.recordWorkerEvent("poll", "worker-1");
    service.recordWorkerEvent("claimed", "worker-1");

    const metrics = service.renderPrometheusMetrics();
    expect(metrics).toContain(
      'resource_portal_worker_events_total{event="poll",worker_id="worker-1"} 2',
    );
    expect(metrics).toContain(
      'resource_portal_worker_events_total{event="claimed",worker_id="worker-1"} 1',
    );
  });

  it("renders deployment outcome and duration metrics", () => {
    const service = new ObservabilityService();

    service.recordDeploymentOutcome("Succeeded", "worker-1", 12_000);

    const metrics = service.renderPrometheusMetrics();
    expect(metrics).toContain(
      'resource_portal_deployments_total{status="Succeeded",worker_id="worker-1"} 1',
    );
    expect(metrics).toContain(
      'resource_portal_deployment_duration_seconds_bucket{status="Succeeded",worker_id="worker-1",le="30"} 1',
    );
    expect(metrics).toContain(
      'resource_portal_deployment_duration_seconds_count{status="Succeeded",worker_id="worker-1"} 1',
    );
  });
});
