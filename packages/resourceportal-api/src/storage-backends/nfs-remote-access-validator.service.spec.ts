import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { NfsRemoteAccessValidatorService } from "./nfs-remote-access-validator.service";
import { StorageCommandRunnerService } from "./storage-command-runner.service";

function harness(results: Array<{ exitCode: number; stdout: string; stderr: string }>) {
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        DOCKER_CONTEXT: "default",
        RESOURCE_VOLUME_RUNTIME_ROOT: "/mnt/resourceportal/volumes",
        STORAGE_REMOTE_VALIDATION_ENABLED: "true",
        STORAGE_REMOTE_VALIDATION_IMAGE: "alpine:3.20",
        STORAGE_REMOTE_VALIDATION_TIMEOUT_MS: 1000,
      };
      return values[key] ?? fallback;
    }),
  };
  const runner = {
    run: vi.fn((program: string, args: string[]) => {
      void program;
      void args;
      return Promise.resolve(
        results.shift() ?? { exitCode: 0, stdout: "", stderr: "" },
      );
    }),
  };
  const validator = new NfsRemoteAccessValidatorService(
    config as unknown as ConfigService,
    runner as unknown as StorageCommandRunnerService,
  );

  return { validator, runner };
}

describe("NfsRemoteAccessValidatorService", () => {
  it("counts only Ready nodes carrying the volumes readiness label", async () => {
    const { validator, runner } = harness([
      {
        exitCode: 0,
        stdout: "node-a|Ready\nnode-b|Ready\nnode-c|Down",
        stderr: "",
      },
      { exitCode: 0, stdout: "true", stderr: "" },
      { exitCode: 0, stdout: "false", stderr: "" },
      { exitCode: 0, stdout: "probe-service", stderr: "" },
      { exitCode: 0, stdout: "Complete 1 second ago|", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ]);

    await expect(
      validator.validate("/srv/resource-portal/storage"),
    ).resolves.toEqual({ ok: true, skipped: false, error: null });

    expect(runner.run).toHaveBeenNthCalledWith(1, "docker", [
      "--context",
      "default",
      "node",
      "ls",
      "--format",
      "{{.ID}}|{{.Status}}",
    ]);
    expect(runner.run).toHaveBeenNthCalledWith(2, "docker", [
      "--context",
      "default",
      "node",
      "inspect",
      "--format",
      '{{index .Spec.Labels "resourceportal.storage.volumes"}}',
      "node-a",
    ]);
  });

  it("probes only the canonical workload Volume runtime namespace", async () => {
    const { validator, runner } = harness([
      { exitCode: 0, stdout: "node-a|Ready", stderr: "" },
      { exitCode: 0, stdout: "true", stderr: "" },
      { exitCode: 0, stdout: "probe-service", stderr: "" },
      { exitCode: 0, stdout: "Complete 1 second ago|", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ]);

    await expect(
      validator.validate("/srv/resource-portal/storage"),
    ).resolves.toEqual({ ok: true, skipped: false, error: null });

    const createCall = runner.run.mock.calls.find(
      ([program, args]) =>
        program === "docker" && args.includes("service") && args.includes("create"),
    );
    expect(createCall).toBeDefined();
    const createArgs = createCall?.[1] ?? [];
    const mountIndex = createArgs.indexOf("--mount");
    expect(createArgs[mountIndex + 1]).toBe(
      "type=bind,source=/mnt/resourceportal/volumes,target=/probe",
    );
    expect(createArgs).toContain("node.labels.resourceportal.storage.volumes==true");
    expect(createArgs.join(" ")).not.toContain("/mnt/resourceportal/secrets");
    expect(createArgs.join(" ")).not.toContain("/mnt/resourceportal/platform");
    expect(createArgs.join(" ")).not.toContain("volume-driver=local");
  });

  it("fails closed when no storage-ready node is eligible", async () => {
    const { validator } = harness([
      { exitCode: 0, stdout: "node-a|Ready\nnode-b|Down", stderr: "" },
      { exitCode: 0, stdout: "false", stderr: "" },
    ]);

    await expect(
      validator.validate("/srv/resource-portal/storage"),
    ).resolves.toEqual({
      ok: false,
      skipped: false,
      error: "No Ready Swarm RemoteLocations with Volume storage readiness",
    });
  });

  it("removes the probe service after a failed task", async () => {
    const { validator, runner } = harness([
      { exitCode: 0, stdout: "node-a|Ready", stderr: "" },
      { exitCode: 0, stdout: "true", stderr: "" },
      { exitCode: 0, stdout: "probe-service", stderr: "" },
      { exitCode: 0, stdout: "Rejected 1 second ago|mount failed", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ]);

    const result = await validator.validate("/srv/resource-portal/storage");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("storage runtime probe failed");
    expect(runner.run).toHaveBeenLastCalledWith(
      "docker",
      expect.arrayContaining(["service", "rm"]),
    );
  });

  it("reports an explicit skip when remote validation is disabled", async () => {
    const config = {
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "STORAGE_REMOTE_VALIDATION_ENABLED" ? "false" : fallback,
      ),
    };
    const runner = { run: vi.fn() };
    const validator = new NfsRemoteAccessValidatorService(
      config as unknown as ConfigService,
      runner as unknown as StorageCommandRunnerService,
    );

    await expect(
      validator.validate("/srv/resource-portal/storage"),
    ).resolves.toEqual({
      ok: true,
      skipped: true,
      error: "Remote storage validation disabled by configuration",
    });
    expect(runner.run).not.toHaveBeenCalled();
  });
});
