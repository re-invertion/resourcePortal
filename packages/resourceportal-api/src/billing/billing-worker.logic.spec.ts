import { describe, expect, it } from "vitest";
import {
  billedReplicaCount,
  effectiveReplicaCount,
  reconciliationPeriods,
} from "./billing-worker.logic";

describe("Stage 10 billing worker policy", () => {
  it("uses desired replicas as effective replicas for a running paid app", () => {
    expect(
      effectiveReplicaCount({
        desiredReplicas: 4,
        appGroupRunning: true,
        singleAppRunning: true,
        billingActive: true,
        pendingDeletion: false,
      }),
    ).toBe(4);
  });

  it("uses zero effective replicas for a stopped app group", () => {
    expect(
      effectiveReplicaCount({
        desiredReplicas: 4,
        appGroupRunning: false,
        singleAppRunning: true,
        billingActive: true,
        pendingDeletion: false,
      }),
    ).toBe(0);
  });

  it("uses zero effective replicas for a stopped single app", () => {
    expect(
      effectiveReplicaCount({
        desiredReplicas: 4,
        appGroupRunning: true,
        singleAppRunning: false,
        billingActive: true,
        pendingDeletion: false,
      }),
    ).toBe(0);
  });

  it("uses zero effective replicas while billing is suspended", () => {
    expect(
      effectiveReplicaCount({
        desiredReplicas: 4,
        appGroupRunning: true,
        singleAppRunning: true,
        billingActive: false,
        pendingDeletion: false,
      }),
    ).toBe(0);
  });

  it("uses zero effective replicas for pending deletion", () => {
    expect(
      effectiveReplicaCount({
        desiredReplicas: 4,
        appGroupRunning: true,
        singleAppRunning: true,
        billingActive: true,
        pendingDeletion: true,
      }),
    ).toBe(0);
  });

  it("bills the smaller actual and effective replica count", () => {
    expect(billedReplicaCount(5, 2)).toBe(2);
    expect(billedReplicaCount(1, 4)).toBe(1);
  });

  it("processes the previous closed minute on first run", () => {
    expect(
      reconciliationPeriods({
        now: new Date("2026-08-30T21:15:42Z"),
        lastCompletedPeriodEnd: null,
        maxPeriods: 10,
      }),
    ).toEqual([
      {
        periodStart: new Date("2026-08-30T21:14:00Z"),
        periodEnd: new Date("2026-08-30T21:15:00Z"),
      },
    ]);
  });

  it("backfills missed minutes oldest-first with a bounded batch", () => {
    const periods = reconciliationPeriods({
      now: new Date("2026-08-30T21:15:42Z"),
      lastCompletedPeriodEnd: new Date("2026-08-30T21:10:00Z"),
      maxPeriods: 3,
    });

    expect(periods).toHaveLength(3);
    expect(periods[0]).toEqual({
      periodStart: new Date("2026-08-30T21:10:00Z"),
      periodEnd: new Date("2026-08-30T21:11:00Z"),
    });
    expect(periods[2]).toEqual({
      periodStart: new Date("2026-08-30T21:12:00Z"),
      periodEnd: new Date("2026-08-30T21:13:00Z"),
    });
  });
});
