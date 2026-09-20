import { describe, expect, it, vi } from "vitest";
import { StorageCommandRunnerService } from "../storage-backends/storage-command-runner.service";
import { InstallerEnrollmentNodeLabelService } from "./installer-enrollment-node-label.service";

function fixture(role: "worker" | "manager") {
  const run = vi
    .fn()
    .mockResolvedValueOnce({
      command: "docker node inspect",
      exitCode: 0,
      stdout: role,
      stderr: "",
    })
    .mockResolvedValueOnce({
      command: "docker node update",
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  return {
    run,
    service: new InstallerEnrollmentNodeLabelService({ run } as unknown as StorageCommandRunnerService),
  };
}

describe("InstallerEnrollmentNodeLabelService v0.2 capabilities", () => {
  it("makes an enrolled worker eligible for tenant workloads and storage-backed workloads", async () => {
    const { run, service } = fixture("worker");

    await service.apply("abcdefghijklmnopqrstuvwxy", "worker", false, false);

    expect(run).toHaveBeenLastCalledWith("docker", [
      "node",
      "update",
      "--label-add",
      "rp.node.storage=true",
      "--label-add",
      "rp.node.tenant-workloads=true",
      "--label-add",
      "resourceportal.storage.volumes=true",
      "--label-add",
      "resourceportal.tenant-workloads=true",
      "abcdefghijklmnopqrstuvwxy",
    ]);
  });

  it("keeps control-plane and ingress capabilities independent for managers", async () => {
    const { run, service } = fixture("manager");

    await service.apply("abcdefghijklmnopqrstuvwxy", "manager", true, false);

    const args = run.mock.calls.at(-1)?.[1] as string[];
    expect(args).toContain("rp.node.storage=true");
    expect(args).toContain("rp.node.tenant-workloads=true");
    expect(args).toContain("resourceportal.tenant-workloads=true");
    expect(args).toContain("rp.node.control-plane=true");
    expect(args).toContain("resourceportal.control-plane=true");
    expect(args).not.toContain("rp.node.ingress=true");
    expect(args).not.toContain("resourceportal.ingress=true");
  });

  it("does not allow a worker enrollment to opt into infrastructure roles", async () => {
    const { service } = fixture("worker");
    await expect(
      service.apply("abcdefghijklmnopqrstuvwxy", "worker", true, false),
    ).rejects.toThrow("Worker enrollment cannot opt into control-plane or ingress");
  });
});
