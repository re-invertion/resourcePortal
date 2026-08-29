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
  private readonly buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

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

  renderPrometheusMetrics() {
    const lines = [
      "# HELP resource_portal_up Resource Portal API process health.",
      "# TYPE resource_portal_up gauge",
      "resource_portal_up 1",
      "# HELP resource_portal_process_started_at_seconds Unix timestamp for API process start.",
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
