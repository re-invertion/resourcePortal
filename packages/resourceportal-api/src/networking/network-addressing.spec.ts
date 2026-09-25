import { describe, expect, it } from "vitest";
import {
  candidateSubnets,
  cidrsOverlap,
  isPrivateIpv4Cidr,
  nextAvailableApplicationAddress,
  nextAvailableGateTunnel,
  nextAvailableNetworkCidr,
  parseIpv4Cidr,
} from "./network-addressing";

describe("network addressing", () => {
  it("normalizes IPv4 CIDRs and rejects invalid inputs", () => {
    expect(parseIpv4Cidr("10.240.1.42/24")?.normalized).toBe("10.240.1.0/24");
    expect(parseIpv4Cidr("10.240.1.999/24")).toBeNull();
    expect(parseIpv4Cidr("10.240.1.0/33")).toBeNull();
  });

  it("detects private ranges and overlap", () => {
    const a = parseIpv4Cidr("10.240.1.0/24")!;
    const b = parseIpv4Cidr("10.240.1.128/25")!;
    const c = parseIpv4Cidr("10.240.2.0/24")!;
    expect(isPrivateIpv4Cidr(a)).toBe(true);
    expect(isPrivateIpv4Cidr(parseIpv4Cidr("100.64.0.0/24")!)).toBe(false);
    expect(cidrsOverlap(a, b)).toBe(true);
    expect(cidrsOverlap(a, c)).toBe(false);
  });

  it("allocates /24 networks deterministically from the platform pool", () => {
    expect(candidateSubnets("10.240.0.0/16", 24)).toHaveLength(256);
    expect(
      nextAvailableNetworkCidr([
        "10.240.0.0/24",
        "10.240.1.0/24",
        "192.168.10.0/24",
      ]),
    ).toBe("10.240.2.0/24");
  });

  it("allocates non-overlapping /30 Gate tunnel pairs", () => {
    expect(nextAvailableGateTunnel([])).toEqual({
      cidr: "100.96.0.0/30",
      server: "100.96.0.1/30",
      client: "100.96.0.2/30",
    });
    expect(nextAvailableGateTunnel(["100.96.0.1/30", "100.96.0.2/30"])).toEqual({
      cidr: "100.96.0.4/30",
      server: "100.96.0.5/30",
      client: "100.96.0.6/30",
    });
  });

  it("allocates stable application addresses after infrastructure reservations", () => {
    const cidr = parseIpv4Cidr("10.240.10.0/24")!;
    expect(nextAvailableApplicationAddress(cidr, [])).toBe("10.240.10.10");
    expect(
      nextAvailableApplicationAddress(cidr, ["10.240.10.10", "10.240.10.11"]),
    ).toBe("10.240.10.12");
  });
});
