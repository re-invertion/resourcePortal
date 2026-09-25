export type NetworkEgressPolicySnapshot = {
  version: 2;
  enabled: boolean;
  revision: number;
  blockedIpv4Cidrs: string[];
  blockedIpv6Cidrs: string[];
};
