import { describe, expect, it } from "vitest";
import { normalizeSwarmCapabilityAdd } from "./swarm-capabilities";

describe("Docker Swarm CapabilityAdd canonicalization", () => {
  it("normalizes CAP_ prefixed Docker inspect output", () => {
    expect(normalizeSwarmCapabilityAdd(["CAP_NET_ADMIN", "CAP_NET_RAW"]))
      .toEqual(["NET_ADMIN", "NET_RAW"]);
  });
  it("supports bare names from legacy engines and null before service setup", () => {
    expect(normalizeSwarmCapabilityAdd(["NET_ADMIN", "cap_net_raw"])).toEqual(["NET_ADMIN", "NET_RAW"]);
    expect(normalizeSwarmCapabilityAdd(null)).toEqual([]);
  });
  it("fails closed on malformed inspect shape", () => {
    expect(() => normalizeSwarmCapabilityAdd({ CAP_NET_ADMIN: true })).toThrow("Malformed");
    expect(() => normalizeSwarmCapabilityAdd(["CAP_NET_ADMIN", 1])).toThrow("Malformed");
  });
});
