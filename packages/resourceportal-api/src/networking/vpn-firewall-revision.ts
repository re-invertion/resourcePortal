/**
 * Avoid modifying live VPN firewall tables every reconcile tick when the
 * effective policy (including resolved workload addresses) is unchanged.
 * Never mark a revision as installed before an atomic restore succeeds.
 */
export type VpnFirewallRevision = { appliedScript?: string };

export function applyVpnFirewallIfChanged(
  state: VpnFirewallRevision,
  script: string,
  atomicRestore: (script: string) => void,
): boolean {
  if (state.appliedScript === script) return false;
  atomicRestore(script);
  state.appliedScript = script;
  return true;
}
