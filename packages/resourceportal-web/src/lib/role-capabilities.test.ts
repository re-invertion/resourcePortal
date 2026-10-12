import { expect, it } from "vitest";
import { capabilityStatus } from "./role-capabilities";

it("derives access capabilities from actual granted role permissions", () => {
  expect(capabilityStatus({ permissions: ["tenant.read", "billing.read"] }, "tenant.read")).toBe("Allowed");
  expect(capabilityStatus({ permissions: ["tenant.read", "billing.read"] }, "membership.invite")).toBe("Not granted");
  expect(capabilityStatus({ permissions: ["*"] }, "membership.invite")).toBe("Allowed");
  expect(capabilityStatus({ name: "Custom role" }, "membership.invite")).toBe("Unknown");
});
