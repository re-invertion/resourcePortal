import { describe, expect, it } from "vitest";
import { parseAndNormalizeCidr } from "./network-egress.cidr";

describe("parseAndNormalizeCidr", () => {
  it("normalizes single IPv4 addresses and network CIDRs", () => {
    expect(parseAndNormalizeCidr("192.168.100.50")).toMatchObject({
      version: 4,
      normalized: "192.168.100.50/32",
    });
    expect(parseAndNormalizeCidr("192.168.100.55/24")).toMatchObject({
      version: 4,
      normalized: "192.168.100.0/24",
    });
  });

  it("accepts IPv6 CIDRs and rejects invalid prefixes", () => {
    expect(parseAndNormalizeCidr("fd00::10/128")).toMatchObject({
      version: 6,
      normalized: "fd00::10/128",
    });
    expect(parseAndNormalizeCidr("192.168.1.1/33")).toBeNull();
    expect(parseAndNormalizeCidr("not-an-ip")).toBeNull();
  });
});
