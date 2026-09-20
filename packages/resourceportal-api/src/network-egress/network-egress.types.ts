export type EgressProtocol = "any" | "tcp" | "udp";

export type NetworkEgressAllowRuleSnapshot = {
  id: string;
  appGroupId: string;
  destinationCidr: string;
  protocol: EgressProtocol;
  port: number;
};

export type NetworkEgressPolicySnapshot = {
  version: 1;
  enabled: boolean;
  revision: number;
  blockedIpv4Cidrs: string[];
  blockedIpv6Cidrs: string[];
  rules: NetworkEgressAllowRuleSnapshot[];
};
