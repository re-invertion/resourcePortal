import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dhcpClientStopped, shouldRestartDhcp,
  DHCP_RESTART_INTERVAL_MS, DHCP_PROOF_LOG_INTERVAL_MS,
} from "./remote-lan-dhcp-recovery";

const live = { exitCode: null, signalCode: null, killed: false };
const exited = { exitCode: 1, signalCode: null, killed: false };
const signaled = { exitCode: null, signalCode: "SIGTERM", killed: false };

describe("LAN DHCP process recovery", () => {
  it("does not recycle a running DHCP process or a Static attachment", () => {
    expect(dhcpClientStopped(live)).toBe(false);
    expect(shouldRestartDhcp("DHCP", live, 0, 100_000)).toBe(false);
    expect(shouldRestartDhcp("Static", exited, 0, 100_000)).toBe(false);
  });

  it("self-heals an exited, signaled, killed or absent DHCP client", () => {
    for (const child of [exited, signaled, {...live, killed: true}, null]) {
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

  it("runner keeps DHCP retries alive and reinitializes only RP-owned endpoints", () => {
    const source = readFileSync(join(__dirname, "remote-lan-node.runner.ts"), "utf8");
    expect(source).toContain('"-f", "-i", device, "-s", SCRIPT');
    expect(source).not.toContain('"-f", "-n", "-i", device');
    expect(source).toContain("shouldRestartDhcp(mode, entry.dhcp");
    expect(source).toContain("detach(entry);");
    expect(source).toContain("managed.set(key, attach(target))");
    expect(source).toContain('RP_LAN_NODE_PROOF_V1');
    expect(source).toContain("LAN evidence pending for attachment");
  });
});
