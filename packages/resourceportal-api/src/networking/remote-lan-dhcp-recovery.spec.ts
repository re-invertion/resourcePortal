import { describe, expect, it, vi } from "vitest";
import type { NodeLanTarget } from "./remote-lan-node-policy";
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
    expect(source).toContain('RP_LAN_NODE_PROOF_V1');
    expect(source).toContain("LAN evidence pending for attachment");
  });
});
