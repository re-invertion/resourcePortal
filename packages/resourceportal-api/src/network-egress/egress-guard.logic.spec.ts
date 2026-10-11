import { describe, expect, it } from "vitest";
import {
  DEFAULT_EGRESS_POLICY,
  appGroupIdFromLabels,
  decodeEgressPolicy,
  encodeEgressPolicy,
  firewallRulesForWorkloads,
  hasAuthoritativeEgressPolicy,
  installedDeniedDestinations,
  renderAtomicEgressRules,
  shouldPreserveExistingFirewallState,
  tenantWorkloads,
} from "./egress-guard.logic";

const appGroupA = "11111111-1111-4111-8111-111111111111";

describe("egress guard logic", () => {
  it("fails closed to the version 2 default policy for a missing, invalid or old snapshot", () => {
    expect(decodeEgressPolicy(undefined)).toEqual(DEFAULT_EGRESS_POLICY);
    expect(decodeEgressPolicy("not-base64-json")).toEqual(DEFAULT_EGRESS_POLICY);
    const old = Buffer.from(
      JSON.stringify({ ...DEFAULT_EGRESS_POLICY, version: 1 }),
      "utf8",
    ).toString("base64");
    expect(decodeEgressPolicy(old)).toEqual(DEFAULT_EGRESS_POLICY);
  });

  it("round-trips a valid enabled policy snapshot", () => {
    const policy = {
      ...DEFAULT_EGRESS_POLICY,
      revision: 7,
    };
    expect(decodeEgressPolicy(encodeEgressPolicy(policy))).toEqual(policy);
  });

  it("normalizes legacy disabled snapshots to mandatory fail-closed enforcement", () => {
    const legacyDisabled = {
      ...DEFAULT_EGRESS_POLICY,
      revision: 8,
      enabled: false,
    };
    expect(decodeEgressPolicy(encodeEgressPolicy(legacyDisabled))).toEqual({
      ...legacyDisabled,
      enabled: true,
    });
  });

  it("identifies explicitly labelled and stack-labelled ResourcePortal App Group tasks", () => {
    expect(
      appGroupIdFromLabels({ "resourceportal.app-group-id": appGroupA }),
    ).toBe(appGroupA);
    expect(
      appGroupIdFromLabels({
        "com.docker.stack.namespace":
          "rp_11111111_1111_4111_8111_111111111111",
      }),
    ).toBe(appGroupA);
    expect(appGroupIdFromLabels({})).toBeUndefined();
  });

  it("maps tenant containers to their docker_gwbridge egress addresses", () => {
    expect(
      tenantWorkloads(
        [
          {
            Id: "container-a",
            Config: { Labels: { "resourceportal.app-group-id": appGroupA } },
          },
          {
            Id: "unmanaged",
            Config: { Labels: {} },
          },
        ],
        {
          Containers: {
            "container-a": { IPv4Address: "172.19.0.18/16" },
            unmanaged: { IPv4Address: "172.19.0.19/16" },
          },
        },
      ),
    ).toEqual([
      {
        containerId: "container-a",
        appGroupId: appGroupA,
        ipv4: "172.19.0.18",
        ipv6: undefined,
      },
    ]);
  });

  it("preserves only a fully linked mandatory firewall state", () => {
    expect(
      shouldPreserveExistingFirewallState({
        forwardChain: true,
        hostChain: true,
        forwardJump: true,
        hostJump: true,
      }),
    ).toBe(true);

    expect(
      shouldPreserveExistingFirewallState({
        forwardChain: true,
        hostChain: true,
        forwardJump: false,
        hostJump: false,
      }),
    ).toBe(false);

    expect(
      shouldPreserveExistingFirewallState({
        forwardChain: true,
        hostChain: true,
        forwardJump: true,
        hostJump: false,
      }),
    ).toBe(false);

    expect(
      shouldPreserveExistingFirewallState({
        forwardChain: false,
        hostChain: false,
        forwardJump: false,
        hostJump: false,
      }),
    ).toBe(false);
  });

  it("rejects every protected private IPv4 range for every tenant workload", () => {
    const rules = firewallRulesForWorkloads(
      DEFAULT_EGRESS_POLICY,
      [{ containerId: "c1", appGroupId: appGroupA, ipv4: "172.19.0.18" }],
      4,
    );

    expect(rules).toHaveLength(DEFAULT_EGRESS_POLICY.blockedIpv4Cidrs.length);
    expect(rules[0]).toEqual([
      "-s",
      "172.19.0.18/32",
      "-d",
      DEFAULT_EGRESS_POLICY.blockedIpv4Cidrs[0],
      "-j",
      "REJECT",
    ]);
    expect(rules.every((rule) => rule.at(-1) === "REJECT")).toBe(true);
  });

  it("still emits deny rules when handed a legacy disabled policy object", () => {
    const rules = firewallRulesForWorkloads(
      { ...DEFAULT_EGRESS_POLICY, enabled: false },
      [{ containerId: "c1", appGroupId: appGroupA, ipv4: "172.19.0.18" }],
      4,
    );
    expect(rules).toHaveLength(DEFAULT_EGRESS_POLICY.blockedIpv4Cidrs.length);
    expect(rules.every((rule) => rule.at(-1) === "REJECT")).toBe(true);
  });
});
describe("atomic egress guard commits", () => {
  it("replaces both guard chains at a single COMMIT boundary", () => {
    const script = renderAtomicEgressRules("RP-TENANT-EGRESS", "RP-TENANT-HOST", [
      ["-s", "172.19.0.18/32", "-d", "10.0.0.0/8", "-j", "REJECT"],
    ]);
    expect(script).toBe([
      "*filter",
      "-F RP-TENANT-EGRESS",
      "-F RP-TENANT-HOST",
      "-A RP-TENANT-EGRESS -s 172.19.0.18/32 -d 10.0.0.0/8 -j REJECT",
      "-A RP-TENANT-HOST -s 172.19.0.18/32 -d 10.0.0.0/8 -j REJECT",
      "COMMIT",
      "",
    ].join("\n"));
    expect(script.match(/COMMIT/g)).toHaveLength(1);
  });

  it("rejects newline injection and invalid chain names before firewall mutation", () => {
    expect(() => renderAtomicEgressRules("RP-CHAIN", "RP-HOST", [
      ["-d", "10.0.0.0/8\n-F INPUT", "-j", "REJECT"],
    ])).toThrow("Unsafe egress policy token");
    expect(() => renderAtomicEgressRules("INPUT\nCOMMIT", "RP-HOST", [])).toThrow();
  });
});

describe("missing policy snapshot after egress-guard restart (#217)", () => {
  it("recovers custom IPv4 deny CIDRs and applies them to newly started workloads", () => {
    const installed = installedDeniedDestinations([
      "-N RP-TENANT-EGRESS",
      "-A RP-TENANT-EGRESS -s 172.19.0.18/32 -d 192.168.0.0/16 -j REJECT",
      "-A RP-TENANT-EGRESS -s 172.19.0.18/32 -d 203.0.113.0/24 -j REJECT",
      "-A UNRELATED -s 172.19.0.18/32 -d 8.8.8.8/32 -j REJECT",
    ].join("\n"), "RP-TENANT-EGRESS", 4);
    expect(installed).toEqual(["192.168.0.0/16", "203.0.113.0/24"]);
    const rules = firewallRulesForWorkloads(
      { ...DEFAULT_EGRESS_POLICY,
        blockedIpv4Cidrs: [...new Set([...DEFAULT_EGRESS_POLICY.blockedIpv4Cidrs, ...installed])],
      },
      [{ containerId: "new-container", appGroupId: appGroupA, ipv4: "172.19.0.42" }],
      4,
    );
    expect(rules).toContainEqual(["-s", "172.19.0.42/32", "-d", "203.0.113.0/24", "-j", "REJECT"]);
  });

  it("recovers IPv6 deny destinations, ignoring other families and non-deny jumps", () => {
    const rules = installedDeniedDestinations([
      "-A RP-TENANT-EGRESS -s 2001:db8::1/128 -d fd42::/32 -j DROP",
      "-A RP-TENANT-EGRESS -s 2001:db8::1/128 -d 192.168.0.0/16 -j REJECT",
      "-A RP-TENANT-EGRESS -s 2001:db8::1/128 -d 2001:4860::/32 -j ACCEPT",
    ].join("\n"), "RP-TENANT-EGRESS", 6);
    expect(rules).toEqual(["fd42::/32"]);
  });

  it("does not interpret malformed destinations as installed restrictions", () => {
    expect(installedDeniedDestinations(
      "-A RP-TENANT-EGRESS -d nonsense/99 -j REJECT",
      "RP-TENANT-EGRESS", 4,
    )).toEqual([]);
  });
});


describe("policy-snapshot validity (#217)", () => {
  it("treats missing, invalid or obsolete snapshots as non-authoritative rather than overwriting active denies", () => {
    expect(hasAuthoritativeEgressPolicy(undefined)).toBe(false);
    expect(hasAuthoritativeEgressPolicy("bad-base64")).toBe(false);
    expect(hasAuthoritativeEgressPolicy(Buffer.from(JSON.stringify({ ...DEFAULT_EGRESS_POLICY, version: 1 })).toString("base64"))).toBe(false);
    expect(hasAuthoritativeEgressPolicy(encodeEgressPolicy(DEFAULT_EGRESS_POLICY))).toBe(true);
  });
});
