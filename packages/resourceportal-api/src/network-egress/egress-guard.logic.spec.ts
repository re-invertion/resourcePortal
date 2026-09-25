import { describe, expect, it } from "vitest";
import {
  DEFAULT_EGRESS_POLICY,
  appGroupIdFromLabels,
  decodeEgressPolicy,
  encodeEgressPolicy,
  firewallRulesForWorkloads,
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

  it("round-trips a valid policy snapshot", () => {
    const policy = {
      ...DEFAULT_EGRESS_POLICY,
      revision: 7,
    };
    expect(decodeEgressPolicy(encodeEgressPolicy(policy))).toEqual(policy);
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

  it("emits no firewall rules when Platform Admin disables enforcement", () => {
    expect(
      firewallRulesForWorkloads(
        { ...DEFAULT_EGRESS_POLICY, enabled: false },
        [{ containerId: "c1", appGroupId: appGroupA, ipv4: "172.19.0.18" }],
        4,
      ),
    ).toEqual([]);
  });
});
