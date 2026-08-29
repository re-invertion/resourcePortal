import { Injectable } from "@nestjs/common";

type RequestMetric = {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
};

@Injectable()
export class ObservabilityService {
  private readonly startedAt = new Date();
  private readonly requestCounts = new Map<string, number>();
  private readonly durationBuckets = new Map<string, number[]>();
  private readonly workerEvents = new Map<string, number>();
  private readonly deploymentOutcomes = new Map<string, number>();
  private readonly deploymentDurationBuckets = new Map<string, number[]>();
  private readonly buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  private readonly deploymentBucketsSeconds = [1, 5, 10, 30, 60, 120, 300, 600, 1800];

  recordRequest(metric: RequestMetric) {
    const labels = this.labels(metric.method, metric.route, metric.statusCode);
    this.requestCounts.set(labels, (this.requestCounts.get(labels) ?? 0) + 1);

    const existing = this.durationBuckets.get(labels) ?? this.buckets.map(() => 0);
    for (let index = 0; index < this.buckets.length; index += 1) {
      if (metric.durationMs <= this.buckets[index]) {
        existing[index] += 1;
      }
    }
    this.durationBuckets.set(labels, existing);
  }

  recordWorkerEvent(event: string, workerId: string) {
    const labels = `event="${escapeLabel(event)}",worker_id="${escapeLabel(workerId)}"`;
    this.workerEvents.set(labels, (this.workerEvents.get(labels) ?? 0) + 1);
  }

  recordDeploymentOutcome(
    status: string,
    workerId: string,
    durationMs: number,
  ) {
    const labels = `status="${escapeLabel(status)}",worker_id="${escapeLabel(workerId)}"`;
    this.deploymentOutcomes.set(
      labels,
      (this.deploymentOutcomes.get(labels) ?? 0) + 1,
    );

    const durationSeconds = durationMs / 1000;
    const existing =
      this.deploymentDurationBuckets.get(labels) ??
      this.deploymentBucketsSeconds.map(() => 0);
    for (
      let index = 0;
      index < this.deploymentBucketsSeconds.length;
      index += 1
    ) {
      if (durationSeconds <= this.deploymentBucketsSeconds[index]) {
        existing[index] += 1;
      }
    }
    this.deploymentDurationBuckets.set(labels, existing);
  }

  renderPrometheusMetrics() {
    const lines = [
      "# HELP resource_portal_up Resource Portal process health.",
      "# TYPE resource_portal_up gauge",
      "resource_portal_up 1",
      "# HELP resource_portal_process_started_at_seconds Unix timestamp for process start.",
      "# TYPE resource_portal_process_started_at_seconds gauge",
      `resource_portal_process_started_at_seconds ${Math.floor(this.startedAt.getTime() / 1000)}`,
      "# HELP resource_portal_http_requests_total Total HTTP requests handled by the API.",
      "# TYPE resource_portal_http_requests_total counter",
    ];

    for (const [labels, count] of this.requestCounts.entries()) {
      lines.push(`resource_portal_http_requests_total{${labels}} ${count}`);
    }

    lines.push(
      "# HELP resource_portal_http_request_duration_ms HTTP request duration in milliseconds.",
      "# TYPE resource_portal_http_request_duration_ms histogram",
    );

    for (const [labels, counts] of this.durationBuckets.entries()) {
      for (let index = 0; index < this.buckets.length; index += 1) {
        lines.push(
          `resource_portal_http_request_duration_ms_bucket{${labels},le="${this.buckets[index]}"} ${counts[index]}`,
        );
      }

      const total = this.requestCounts.get(labels) ?? 0;
      lines.push(
        `resource_portal_http_request_duration_ms_bucket{${labels},le="+Inf"} ${total}`,
        `resource_portal_http_request_duration_ms_count{${labels}} ${total}`,
      );
    }

    lines.push(
      "# HELP resource_portal_worker_events_total Worker lifecycle and polling events.",
      "# TYPE resource_portal_worker_events_total counter",
    );
    for (const [labels, count] of this.workerEvents.entries()) {
      lines.push(`resource_portal_worker_events_total{${labels}} ${count}`);
    }

    lines.push(
      "# HELP resource_portal_deployments_total Deployment outcomes processed by workers.",
      "# TYPE resource_portal_deployments_total counter",
    );
    for (const [labels, count] of this.deploymentOutcomes.entries()) {
      lines.push(`resource_portal_deployments_total{${labels}} ${count}`);
    }

    lines.push(
      "# HELP resource_portal_deployment_duration_seconds End-to-end worker deployment processing duration.",
      "# TYPE resource_portal_deployment_duration_seconds histogram",
    );
    for (const [labels, counts] of this.deploymentDurationBuckets.entries()) {
      for (
        let index = 0;
        index < this.deploymentBucketsSeconds.length;
        index += 1
      ) {
        lines.push(
          `resource_portal_deployment_duration_seconds_bucket{${labels},le="${this.deploymentBucketsSeconds[index]}"} ${counts[index]}`,
        );
      }
      const total = this.deploymentOutcomes.get(labels) ?? 0;
      lines.push(
        `resource_portal_deployment_duration_seconds_bucket{${labels},le="+Inf"} ${total}`,
        `resource_portal_deployment_duration_seconds_count{${labels}} ${total}`,
      );
    }

    return `${lines.join("\n")}\n`;
  }

  private labels(method: string, route: string, statusCode: number) {
    return [
      `method="${escapeLabel(method)}"`,
      `route="${escapeLabel(route)}"`,
      `status_code="${statusCode}"`,
    ].join(",");
  }
}

function escapeLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
