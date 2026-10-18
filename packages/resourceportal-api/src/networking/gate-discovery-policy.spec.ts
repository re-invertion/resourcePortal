import { describe, expect, it } from "vitest";
import { validateGateDiscoveryRules, runtimeGateDiscoveryRules } from "./gate-discovery-policy";

const attached = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const allowed = new Set([attached]);
const rule = { attachmentId: attached, protocol: "mdns" };

describe("Gate discovery authorization", () => {
  it("defaults to deny and serializes only attached protocol grants", () => {
    expect(validateGateDiscoveryRules([], allowed)).toEqual([]);
    expect(runtimeGateDiscoveryRules(validateGateDiscoveryRules([rule], allowed))).toEqual([
      { attachmentAlias: "rp-att-" + attached, protocol: "mdns" },
    ]);
  });
  it("does not grant another tenant, an unknown protocol or duplicated scope", () => {
    for (const value of [
      [{ ...rule, attachmentId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }],
      [{ ...rule, protocol: "all" }],
      [rule, rule],
      new Array(129).fill(rule),
    ]) {
      expect(() => validateGateDiscoveryRules(value, allowed)).toThrow();
    }
  });
});
