import { describe, expect, it, vi } from "vitest";
import { applyVpnFirewallIfChanged, type VpnFirewallRevision } from "./vpn-firewall-revision";

describe("Gate and Device VPN firewall churn and fail-closed retry (#210)", () => {
  for (const runtime of ["Gate VPN", "Device VPN"]) {
    it(`${runtime} does not rewrite the firewall for unchanged policy or targets`, () => {
      const state: VpnFirewallRevision = {};
      const restore = vi.fn();
      expect(applyVpnFirewallIfChanged(state, "atomic-policy-A", restore)).toBe(true);
      for (let i = 0; i < 20; i++) {
        expect(applyVpnFirewallIfChanged(state, "atomic-policy-A", restore)).toBe(false);
      }
      expect(restore).toHaveBeenCalledTimes(1);
      expect(applyVpnFirewallIfChanged(state, "atomic-policy-B", restore)).toBe(true);
      expect(restore).toHaveBeenCalledTimes(2);
    });

    it(`${runtime} retains last successful policy after failed restore and retries`, () => {
      const state: VpnFirewallRevision = {};
      const restore = vi.fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => { throw new Error("iptables-restore failed"); })
        .mockImplementationOnce(() => undefined);
      applyVpnFirewallIfChanged(state, "policy-before", restore);
      expect(() => applyVpnFirewallIfChanged(state, "policy-after", restore))
        .toThrow("iptables-restore failed");
      expect(state.appliedScript).toBe("policy-before");
      expect(applyVpnFirewallIfChanged(state, "policy-after", restore)).toBe(true);
      expect(state.appliedScript).toBe("policy-after");
      expect(restore).toHaveBeenCalledTimes(3);
    });
  }
});
