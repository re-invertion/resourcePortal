import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { mapBillingAccount } from "./tenants.view";

function billing(balance: string, threshold = "10") {
  return {
    id: "billing-id",
    tenantId: "tenant-id",
    balance: new Prisma.Decimal(balance),
    currency: "credits",
    informationThreshold: new Prisma.Decimal(threshold),
  };
}

describe("mapBillingAccount", () => {
  it("returns BillingSuspended for zero or negative balance", () => {
    expect(mapBillingAccount(billing("0")).billingState).toBe("BillingSuspended");
    expect(mapBillingAccount(billing("-1")).billingState).toBe("BillingSuspended");
  });

  it("returns LowBalance at or below information threshold", () => {
    expect(mapBillingAccount(billing("5")).billingState).toBe("LowBalance");
    expect(mapBillingAccount(billing("10")).billingState).toBe("LowBalance");
  });

  it("returns Active above information threshold", () => {
    expect(mapBillingAccount(billing("10.0001")).billingState).toBe("Active");
  });
});
