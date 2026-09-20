import { describe, expect, it } from "vitest";
import {
  DEFAULT_EGRESS_POLICY,
  appGroupIdFromLabels,
  decodeEgressPolicy,
  encodeEgressPolicy,
  firewallRulesForWorkloads,
  internalPortFirewallRules,
  tenantWorkloads,
} from "./egress-guard.logic";
import type { NetworkEgressPolicySnapshot } from "./network-egress.types";

const appGroupA = "11111111-1111-4111-8111-111111111111";
const appGroupB = "22222222-2222-4222-8222-222222222222";

describe("egress guard logic", () => {
  it("fails closed to the default protected private ranges for a missing or invalid policy", () => {
    expect(decodeEgressPolicy(undefined)).toEqual(DEFAULT_EGRESS_POLICY);
    expect(decodeEgressPolicy(Buffer.from("not-json").toString("base64"))).toEqual(
      DEFAULT_EGRESS_POLICY,
    );
    expect(DEFAULT_EGRESS_POLICY.enabled).toBe(true);
    expect(DEFAULT_EGRESS_POLICY.blockedIpv4Cidrs).toContain("192.168.0.0/16");
    expect(DEFAULT_EGRESS_POLICY.blockedIpv4Cidrs).toContain("169.254.0.0/16");
  });

  it("round-trips a valid policy snapshot", () => {
    const policy: NetworkEgressPolicySnapshot = {
      ...DEFAULT_EGRESS_POLICY,
      revision: 7,
      rules: [
        {
          id: "rule-1",
          appGroupId: appGroupA,
          destinationCidr: "192.168.100.50/32",
          protocol: "tcp",
          port: 443,
        },
      ],
    };
    expect(decodeEgressPolicy(encodeEgressPolicy(policy))).toEqual(policy);
  });

  it("identifies both explicitly labelled and legacy ResourcePortal App Group tasks", () => {
    expect(
      appGroupIdFromLabels({ "resourceportal.app-group-id": appGroupA }),
    ).toBe(appGroupA);
    expect(
      appGroupIdFromLabels({
        "com.docker.stack.namespace":
          "rp_11111111_1111_4111_8111_111111111111",
      }),
    ).toBe(appGroupA);
    expect(
      appGroupIdFromLabels({
        "com.docker.stack.namespace": "resourceportal-control-plane",
      }),
    ).toBeUndefined();
  });

  it("maps local tenant containers to their docker_gwbridge egress addresses", () => {
    expect(
      tenantWorkloads(
        [
          {
            Id: "container-a",
            Config: {
              Labels: { "resourceportal.app-group-id": appGroupA },
            },
          },
          {
            Id: "control-plane",
            Config: {
              Labels: {
                "com.docker.stack.namespace": "resourceportal-control-plane",
              },
            },
          },
        ],
        {
          Containers: {
            "container-a": { IPv4Address: "172.19.0.18/16" },
            "control-plane": { IPv4Address: "172.19.0.10/16" },
          },
        },
      ),
    ).toEqual([
      {
        containerId: "container-a",
        appGroupId: appGroupA,
        ipv4: "172.19.0.18",
        ipv6: undefined,
        internalPortExposures: [],
      },
    ]);
  });

  it("places App Group-specific allow rules before private-network rejects", () => {
    const policy: NetworkEgressPolicySnapshot = {
      ...DEFAULT_EGRESS_POLICY,
      revision: 2,
      rules: [
        {
          id: "rule-a",
          appGroupId: appGroupA,
          destinationCidr: "192.168.100.50/32",
          protocol: "tcp",
          port: 443,
        },
        {
          id: "rule-b",
          appGroupId: appGroupB,
          destinationCidr: "192.168.100.60/32",
          protocol: "tcp",
          port: 5432,
        },
      ],
    };
    const rules = firewallRulesForWorkloads(
      policy,
      [{ containerId: "c1", appGroupId: appGroupA, ipv4: "172.19.0.18", internalPortExposures: [] }],
      4,
    );
    expect(rules[0]).toEqual([
      "-s",
      "172.19.0.18/32",
      "-d",
      "192.168.100.50/32",
      "-p",
      "tcp",
      "--dport",
      "443",
      "-j",
      "RETURN",
    ]);
    expect(rules.some((rule) => rule.includes("192.168.100.60/32"))).toBe(false);
    expect(rules).toContainEqual([
      "-s",
      "172.19.0.18/32",
      "-d",
      "192.168.0.0/16",
      "-j",
      "REJECT",
    ]);
  });

  it("emits no firewall rules when the Platform Admin disables enforcement", () => {
    expect(
      firewallRulesForWorkloads(
        { ...DEFAULT_EGRESS_POLICY, enabled: false },
        [{ containerId: "c1", appGroupId: appGroupA, ipv4: "172.19.0.18", internalPortExposures: [] }],
        4,
      ),
    ).toEqual([]);
  });
  it("bypasses private-network egress denies only for privileged App Groups", () => {
    const policy: NetworkEgressPolicySnapshot = {
      ...DEFAULT_EGRESS_POLICY,
      privilegedAppGroupIds: [appGroupA],
    };
    expect(
      firewallRulesForWorkloads(
        policy,
        [
          {
            containerId: "c1",
            appGroupId: appGroupA,
            ipv4: "172.19.0.18",
            internalPortExposures: [],
          },
        ],
        4,
      ),
    ).toEqual([]);
  });

  it("allows internal published ports only from the trusted cluster CIDR", () => {
    const encoded = Buffer.from(
      JSON.stringify([{ publishedPort: 53, protocol: "udp" }]),
      "utf8",
    ).toString("base64");
    const workloads = tenantWorkloads(
      [
        {
          Id: "container-dns",
          Config: {
            Labels: {
              "resourceportal.app-group-id": appGroupA,
              "resourceportal.internal-port-exposures-b64": encoded,
            },
          },
        },
      ],
      { Containers: { "container-dns": { IPv4Address: "172.19.0.22/16" } } },
    );
    const rules = internalPortFirewallRules(
      {
        ...DEFAULT_EGRESS_POLICY,
        internalNetworkCidrs: ["192.168.100.0/24"],
      },
      workloads,
      4,
    );
    expect(rules).toEqual([
      [
        "-s",
        "192.168.100.0/24",
        "-p",
        "udp",
        "-m",
        "conntrack",
        "--ctstate",
        "DNAT",
        "--ctorigdstport",
        "53",
        "-j",
        "RETURN",
      ],
      [
        "-p",
        "udp",
        "-m",
        "conntrack",
        "--ctstate",
        "DNAT",
        "--ctorigdstport",
        "53",
        "-j",
        "REJECT",
      ],
    ]);
  });

});
