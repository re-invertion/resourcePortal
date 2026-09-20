export const PLATFORM_EGRESS_POLICY_ID =
  "00000000-0000-4000-8000-000000000022";

export const EGRESS_GUARD_SERVICE_SUFFIX = "egress-guard";
export const EGRESS_POLICY_ENV = "RESOURCEPORTAL_EGRESS_POLICY_B64";

export const DEFAULT_BLOCKED_IPV4_CIDRS = [
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
] as const;

export const DEFAULT_BLOCKED_IPV6_CIDRS = [
  "::1/128",
  "fc00::/7",
  "fe80::/10",
] as const;
