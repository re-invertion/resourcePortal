import { describe, expect, it } from "vitest";
import { missingEffectiveCapabilities } from "./runtime-capabilities";

describe("effective Linux privileges of RP network agents", () => {
  it("accepts the required bits", () => {
    const bits = (1n << 12n) | (1n << 13n) | (1n << 21n);
    expect(missingEffectiveCapabilities(`Name:\ttest\nCapEff:\t${bits.toString(16).padStart(16, "0")}\n`, ["NET_ADMIN", "NET_RAW", "SYS_ADMIN"])).toEqual([]);
  });
  it("fails closed without capabilities", () => {
    expect(missingEffectiveCapabilities("CapEff:\t0000000000000000\n", ["SYS_ADMIN", "NET_ADMIN"])).toEqual(["SYS_ADMIN", "NET_ADMIN"]);
  });
  it("fails closed if the kernel status cannot be read", () => {
    expect(() => missingEffectiveCapabilities("no capabilities", ["NET_ADMIN"])).toThrow("unavailable");
  });
});
