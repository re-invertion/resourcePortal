import { describe, expect, it } from "vitest";
import { billingReplicaSummary } from "./billing-usage-charts";

describe("#399 replica usage summaries", () => {
  it("keeps peak, latest and sample average distinct for billed and desired replicas", () => {
    const summary = billingReplicaSummary([
      { billedReplicas: 3, desiredReplicas: 8 },
      { billedReplicas: 7, desiredReplicas: 9 },
      { billedReplicas: 2, desiredReplicas: 4 },
    ]);
    expect(summary.peakBilled).toBe(7);
    expect(summary.peakDesired).toBe(9);
    expect(summary.latestBilled).toBe(2);
    expect(summary.latestDesired).toBe(4);
    expect(summary.averageBilled).toBe(4);
    expect(summary.averageDesired).toBe(7);
  });
  it("represents missing samples without a fictitious replica peak", () => {
    expect(billingReplicaSummary([])).toEqual({
      peakBilled: 0, peakDesired: 0, latestBilled: 0, latestDesired: 0,
      averageBilled: 0, averageDesired: 0,
    });
  });
});
