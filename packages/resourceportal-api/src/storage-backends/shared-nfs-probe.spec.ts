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
