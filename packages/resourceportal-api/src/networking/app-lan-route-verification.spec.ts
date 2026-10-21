import { describe, expect, it } from "vitest";
import { effectiveLanRouteMatches } from "./app-lan-route-verification";

describe("Site VPN route dataplane verification", () => {
  it("accepts only the expected overlay next hop and device", () => {
    expect(effectiveLanRouteMatches([{ gateway: "10.200.2.8", dev: "eth2", dst: "192.168.100.1" }], "10.200.2.8", "eth2")).toBe(true);
  });
  it("rejects fallback via Docker bridge even if TCP connectivity exists", () => {
    expect(effectiveLanRouteMatches([{ gateway: "172.19.0.1", dev: "eth1" }], "10.200.2.8", "eth2")).toBe(false);
  });
  it("rejects empty, malformed or blackhole destinations", () => {
    expect(effectiveLanRouteMatches([], "10.200.2.8", "eth2")).toBe(false);
    expect(effectiveLanRouteMatches([{ type: "blackhole", gateway: "10.200.2.8", dev: "eth2" }], "10.200.2.8", "eth2")).toBe(false);
  });
});
