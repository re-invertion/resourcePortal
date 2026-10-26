import { describe, expect, it, vi } from "vitest";
import { nodeLanTransportMatches, type NodeLanTarget, type NodeLanLink } from "./remote-lan-node-policy";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dhcpClientStopped, shouldRestartDhcp, reconcileNodeLanDhcp,
  DHCP_RESTART_INTERVAL_MS, DHCP_PROOF_LOG_INTERVAL_MS,
} from "./remote-lan-dhcp-recovery";

const live = { pid: 42, exitCode: null, signalCode: null, killed: false };
const exited = { pid: 42, exitCode: 1, signalCode: null, killed: false };
const signaled = { pid: 42, exitCode: null, signalCode: "SIGTERM", killed: false };

describe("LAN DHCP process recovery", () => {
  it("does not recycle a running DHCP process or a Static attachment", () => {
    expect(dhcpClientStopped(live)).toBe(false);
    expect(shouldRestartDhcp("DHCP", live, 0, 100_000)).toBe(false);
    expect(shouldRestartDhcp("Static", exited, 0, 100_000)).toBe(false);
  });

  it("self-heals an exited, signaled, killed or absent DHCP client", () => {
    for (const child of [exited, signaled, {...live, killed: true}, {...live, pid: undefined}, null]) {
      expect(dhcpClientStopped(child)).toBe(true);
      expect(shouldRestartDhcp("DHCP", child, 1_000, 21_000)).toBe(true);
    }
  });

  it("rate-limits reattachment to prevent restart loops", () => {
    expect(shouldRestartDhcp("DHCP", exited, 40_000, 40_001)).toBe(false);
    expect(shouldRestartDhcp("DHCP", exited, 40_000, 59_999)).toBe(false);
    expect(shouldRestartDhcp("DHCP", exited, 40_000, 60_000)).toBe(true);
    expect(shouldRestartDhcp("DHCP", exited, 40_000, 39_999)).toBe(false);
    expect(DHCP_RESTART_INTERVAL_MS).toBe(20_000);
    expect(DHCP_PROOF_LOG_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("rate-limits real revoke -> grant reconciliation cycles after repeated crashes", () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const target = { id: "container1", pid: 42, attachment: {
      attachmentId: id, addressMode: "DHCP",
    }, tunnel: {} } as NodeLanTarget;
    const key = target.id + ":" + id;
    type Entry = {
      target: NodeLanTarget; device: string;
      dhcp: { killed: boolean; pid: number; exitCode: number | null; signalCode: string | null } | null;
    };
    const dead = (): Entry => ({ target, device: "rp-a-aaaaaaaa",
      dhcp: { killed: false, pid: 5, exitCode: 1, signalCode: null } });
    const managed = new Map<string, Entry>([[key, dead()]]);
    const desired = new Map([[key, target]]);
    const restartAt = new Map<string, number>();
    const removed = vi.fn();
    const attached = vi.fn((next: NodeLanTarget): Entry => ({
      target: next, device: "rp-a-aaaaaaaa",
      dhcp: { killed: false, pid: 6, exitCode: null, signalCode: null },
    }));
    const stopped = vi.fn();
    const cycle = (now: number) => reconcileNodeLanDhcp(
      managed, desired, [], removed, () => [], () => {}, attached,
      restartAt, now, stopped,
    );
    cycle(100_000); // Existing policy revokes the failed child before granting.
    expect(removed).toHaveBeenCalledTimes(1);
    expect(attached).not.toHaveBeenCalled();
    expect(managed.size).toBe(0);
    cycle(105_000);
    cycle(119_999);
    expect(attached).not.toHaveBeenCalled();
    cycle(120_000);
    expect(attached).toHaveBeenCalledTimes(1);
    managed.set(key, dead()); // A second crash re-enters the same bounded path.
    cycle(125_000);
    cycle(130_000);
    expect(removed).toHaveBeenCalledTimes(2);
    expect(attached).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(2);
    cycle(145_000);
    expect(attached).toHaveBeenCalledTimes(2);
  });

  it("does not delay Static attachment grants", () => {
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const target = { id: "static1", pid: 43, attachment: {
      attachmentId: id, addressMode: "Static",
    }, tunnel: {} } as NodeLanTarget;
    const key = target.id + ":" + id;
    const managed = new Map<string, { target: NodeLanTarget; device: string; dhcp: null }>();
    const attached = vi.fn((next: NodeLanTarget) => ({ target: next, device: "rp-a-bbbbbbbb", dhcp: null }));
    reconcileNodeLanDhcp(managed, new Map([[key, target]]), [],
      () => {}, () => [], () => {}, attached, new Map([[key, 100_000]]),
      100_001, () => {});
    expect(attached).toHaveBeenCalledTimes(1);
    expect(managed.has(key)).toBe(true);
  });

  it("runner keeps DHCP retries alive and reinitializes only RP-owned endpoints", () => {
    const source = readFileSync(join(__dirname, "remote-lan-node.runner.ts"), "utf8");
    expect(source).toContain('"-f", "-i", device, "-s", SCRIPT');
    expect(source).not.toContain('"-f", "-n", "-i", device');
    expect(source).toContain("reconcileNodeLanDhcp(managed, desired, pids");
    expect(source).toContain("reattachment delayed to prevent restart loops");
    expect(source).toContain("lastDhcpRestartAt");
    expect(source).toContain("if (dhcpClientStopped(entry.dhcp))");
    // Exercise the same code path the systemd/Swarm node-agent runs.
    expect(source).toContain("prepareNodeLanLinkForGrant(target, device, before");
    expect(source).toContain("nodeLanTransportMatches(current[0], entry.target)");
    expect(source).toContain("nodeLanTransportMatches(link, target)");
    expect(source).toContain("policy.fullyConfigured && addresses.length === 1");
    expect(source).toContain("currentStaticClaim(target.pid, claim)");
    expect(source).toContain('unlinkSync("/run/resourceportal-remote-lan/" + device)');
    expect(source).toContain('RP_LAN_NODE_PROOF_V1');
    expect(source).toContain("LAN evidence pending for attachment");
  });
});

describe("live LAN reconciliation after Swarm Gateway task rotation", () => {
  function scenario(mode: "DHCP" | "Static") {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const device = "rp-a-1234abcd";
    const target = {
      id: "c".repeat(64), pid: 4242,
      attachment: { attachmentId: id, addressMode: mode,
        gatewayOverlayIp: "10.200.2.10", macAddress: "62:bc:1c:51:53:ef",
      },
      tunnel: { appOverlayIp: "10.200.2.2", gatewayOverlayIp: "10.200.2.10" },
    } as NodeLanTarget;
    const key = target.id + ":" + id;
    type Entry = {
      target: NodeLanTarget; device: string;
      dhcp: { pid: number; killed: boolean; exitCode: number | null; signalCode: string | null } | null;
    };
    let observed: NodeLanLink | undefined = {
      ifname: device, ifalias: "rp-lan:" + id, address: "62:bc:1c:51:53:ef",
      linkinfo: { info_kind: "gretap",
        info_data: { local: "10.200.2.2", remote: "10.200.2.125" } },
    };
    const entry = (current: NodeLanTarget): Entry => ({
      target: current, device,
      dhcp: mode === "DHCP" ? { pid: 200, killed: false, exitCode: null, signalCode: null } : null,
    });
    const managed = new Map([[key, entry(target)]]);
    const desired = new Map([[key, target]]);
    const revoked = vi.fn(() => { observed=undefined; });
    const grant = vi.fn((next: NodeLanTarget) => {
      observed = { ifname: device, ifalias: "rp-lan:" + id,
        address: next.attachment.macAddress,
        linkinfo: { info_kind: "gretap", info_data: {
          local: next.tunnel.appOverlayIp, remote: next.tunnel.gatewayOverlayIp,
        } } };
      return entry(next);
    });
    const stopped = vi.fn();
    const cycle = () => reconcileNodeLanDhcp(managed, desired, [4242],
      revoked, () => observed ? [observed] : [],
      () => { throw new Error("unexpected orphan deletion"); },
      grant, new Map(), 100_000, stopped,
      current => observed !== undefined &&
        nodeLanTransportMatches(observed, current.target));
    return { managed, desired, target, observed: () => observed, revoked, grant, stopped, cycle };
  }

  for(const mode of ["DHCP", "Static"] as const) {
    it("rebuilds a still-managed "+mode+" tunnel when kernel remote diverges from current policy", () => {
      const state = scenario(mode);
      state.cycle();
      expect(state.revoked).toHaveBeenCalledTimes(1);
      expect(state.grant).toHaveBeenCalledTimes(1);
      expect(state.observed()?.linkinfo?.info_data?.remote).toBe("10.200.2.10");
      expect(state.managed.size).toBe(1);
      expect(state.stopped).not.toHaveBeenCalled();
      state.cycle();
      expect(state.revoked).toHaveBeenCalledTimes(1);
      expect(state.grant).toHaveBeenCalledTimes(1);
    });
  }

  it("re-reconciles new Gateway task address while preserving attachment identity", () => {
    const state = scenario("DHCP");
    state.cycle();
    const key = [...state.desired.keys()][0];
    const moved = { ...state.target,
      attachment: { ...state.target.attachment, gatewayOverlayIp: "10.200.2.11" },
      tunnel: { ...state.target.tunnel, gatewayOverlayIp: "10.200.2.11" },
    };
    state.desired.set(key, moved);
    state.cycle();
    expect(state.revoked).toHaveBeenCalledTimes(2);
    expect(state.grant).toHaveBeenCalledTimes(2);
    expect(state.observed()?.linkinfo?.info_data?.remote).toBe("10.200.2.11");
  });
});
