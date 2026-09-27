import { describe, expect, it } from "vitest";
import { ObservabilityService } from "./observability.service";

describe("ResourceBot observability metrics", () => {
  it("renders bounded ResourceBot outcome, latency, token and credit metrics", async () => {
    const service = new ObservabilityService();
    service.recordResourceBotDuration("retrieval", 125);
    service.recordResourceBotDuration("provider", 750);
    service.recordResourceBotUsage({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 30,
      embeddingInputTokens: 12,
      chargedCredits: "0.0042",
    });
    service.recordResourceBotRequest("answered");

    const metrics = await service.renderPrometheusMetrics();

    expect(metrics).toContain(
      'resource_portal_resourcebot_requests_total{outcome="answered"} 1',
    );
    expect(metrics).toContain(
      'resource_portal_resourcebot_stage_duration_seconds_count{stage="retrieval"} 1',
    );
    expect(metrics).toContain(
      'resource_portal_resourcebot_tokens_total{token_kind="embedding_input"} 12',
    );
    expect(metrics).toContain(
      "resource_portal_resourcebot_charged_credits_total 0.0042",
    );
    expect(metrics).not.toContain("tenant_id=");
    expect(metrics).not.toContain("user_id=");
  });
});
