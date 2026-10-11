import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sharedNfsProbeCommand } from "./shared-nfs-probe";

describe("shared NFS validation (#228)", () => {
  it("requires actual NFS mount and cross-node marker visibility", () => {
    const command = sharedNfsProbeCommand(3, "abcdefabcdef1234");
    expect(command).toContain('/proc/mounts');
    expect(command).toContain('^nfs(4)?$');
    expect(command).toContain('"$files" -ge "3"');
    expect(command).toContain('StorageProbeNotSharedAcrossNodes');
    expect(command).toContain('abcdefabcdef1234');
    expect(command).toContain('cat "$marker"');
    expect(command).not.toContain("printf ok >");
  });
  it("emits a syntactically valid POSIX shell script", () => {
    const command = sharedNfsProbeCommand(2, "abcdefabcdef1234");
    const result = spawnSync("sh", ["-n"], { input: command, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("fails closed on invalid challenge inputs", () => {
    expect(() => sharedNfsProbeCommand(0, "abcdefabcdef")).toThrow();
    expect(() => sharedNfsProbeCommand(2, "unsafe/path")).toThrow();
  });
});

  // Regression: single-node local filesystem is permitted, but multi-node local fallback is rejected.
describe("filesystem type by storage topology (#228)", () => {
  it("allows a one-node local filesystem probe without requiring NFS", () => {
    const script = sharedNfsProbeCommand(1, "abcdefabcdef1234");
    expect(script).not.toContain("StorageProbeNotNfs");
    expect(script).toContain('if [ "$files" -ge "1" ]');
    const checked = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
    expect(checked.status).toBe(0);
  });
  it("retains the NFS-only invariant for two or more storage nodes", () => {
    const script = sharedNfsProbeCommand(2, "abcdefabcdef1234");
    expect(script).toContain("StorageProbeNotNfs");
    expect(script).toContain('if [ "$files" -ge "2" ]');
  });
});
