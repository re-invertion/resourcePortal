import { describe, expect, it, vi } from "vitest";
import { StackRuntimeService } from "./stack-runtime.service";
import type { ConfigService } from "@nestjs/config";

describe("Swarm scale error diagnostics (#450)", () => {
  function fixture(errors: string) {
    const runtime = new StackRuntimeService({ get: vi.fn() } as unknown as ConfigService);
    const docker = vi.fn()
      .mockResolvedValueOnce({ command: "docker service scale", exitCode: 124, stdout: "", stderr: "timed out" })
      .mockResolvedValueOnce({ command: "docker service ps", exitCode: 0, stdout: errors, stderr: "" });
    (runtime as unknown as { runDocker: typeof docker }).runDocker = docker;
    return { runtime, docker };
  }

  it("reports registry pull denial without leaking raw task detail", async () => {
    const { runtime, docker } = fixture("denied: authorization required for private image token=secret");
    const result = await runtime.scaleServices([{ stackName: "rp_tenant", serviceName: "web", replicas: 1 }]);
    expect(result[0].stderr).toContain("ImagePullAuthorizationFailed");
    expect(result[0].stderr).not.toContain("token=secret");
    expect(docker).toHaveBeenCalledWith([
      "service", "ps", "--no-trunc", "--format", "{{.Error}}", "rp_tenant_web",
    ], 10_000);
  });

  it("fails closed with unknown outcome when Swarm has no task cause", async () => {
    const { runtime } = fixture("");
    const result = await runtime.scaleServices([{ stackName: "rp_tenant", serviceName: "web", replicas: 1 }]);
    expect(result[0].stderr).toContain("SwarmScaleOutcomeUnknown");
  });

  it("preserves successful scale without extra task inspection", async () => {
    const runtime = new StackRuntimeService({ get: vi.fn() } as unknown as ConfigService);
    const docker = vi.fn().mockResolvedValue({ command: "docker service scale", exitCode: 0, stdout: "", stderr: "" });
    (runtime as unknown as { runDocker: typeof docker }).runDocker = docker;
    await expect(runtime.scaleServices([{ stackName: "rp_tenant", serviceName: "web", replicas: 1 }])).resolves.toHaveLength(1);
    expect(docker).toHaveBeenCalledTimes(1);
  });
});
