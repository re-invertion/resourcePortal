import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Stage 19 observability stack", () => {
  it("ships Docker logs to Loki and exposes an OTLP tracing collector", () => {
    const stack = readFileSync(
      resolve(__dirname, "../../../../config/observability/docker-stack.yml"),
      "utf8",
    );

    expect(stack).toContain("loki:");
    expect(stack).toContain("promtail:");
    expect(stack).toContain("otel-collector:");
    expect(stack).toContain("4318");
  });

  it("contains Prometheus and Alertmanager with ResourcePortal alert rules", () => {
    const stack = readFileSync(
      resolve(__dirname, "../../../../config/observability/docker-stack.yml"),
      "utf8",
    );
    const rules = readFileSync(
      resolve(__dirname, "../../../../config/observability/prometheus/rules.yml"),
      "utf8",
    );

    expect(stack).toContain("prometheus:");
    expect(stack).toContain("alertmanager:");
    expect(rules).toContain("ResourcePortalApiDown");
    expect(rules).toContain("ResourcePortalRemoteLocationUnhealthy");
    expect(rules).toContain("ResourcePortalStorageBackendLowCapacity");
    expect(rules).toContain("ResourcePortalHighHttp5xxRate");
  });
});
