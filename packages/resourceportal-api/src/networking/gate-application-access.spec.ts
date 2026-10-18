import { describe, expect, it } from "vitest";
import { validateApplicationLanRules, runtimeApplicationLanRules } from "./gate-application-access";
const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const cidrs = ["192.168.50.0/24"];
const allowed = new Set([id]);
const rule = {
  attachmentId: id,
  destinationCidr: "192.168.50.21/32",
  protocol: "tcp",
  port: 1883,
};
describe("generic per-application LAN policy", () => {
  it("normalizes a source alias and scoped rule", () => {
    const value = validateApplicationLanRules([rule], cidrs, allowed);
    expect(value).toEqual([rule]);
    expect(runtimeApplicationLanRules(value)).toEqual([{
      attachmentAlias: "rp-att-" + id,
      destinationCidr: "192.168.50.21/32",
      protocol: "tcp",
      port: 1883,
    }]);
  });
  it("rejects foreign source, public or broad destinations, invalid port and protocol", () => {
    for (const invalid of [
      { ...rule, attachmentId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
      { ...rule, destinationCidr: "0.0.0.0/0" },
      { ...rule, destinationCidr: "192.168.0.0/16" },
      { ...rule, destinationCidr: "8.8.8.8" },
      { ...rule, protocol: "all" },
      { ...rule, port: 0 }, { ...rule, port: 65536 },
    ]) {
      expect(() => validateApplicationLanRules([invalid], cidrs, allowed)).toThrow();
    }
  });
  it("rejects duplicates and oversized configurations", () => {
    expect(() => validateApplicationLanRules([rule,rule],cidrs,allowed)).toThrow();
    expect(() => validateApplicationLanRules(Array(257).fill(rule),cidrs,allowed)).toThrow();
  });
});
