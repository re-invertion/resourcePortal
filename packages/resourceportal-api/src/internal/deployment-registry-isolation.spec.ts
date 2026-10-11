import { RegistryAuthType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { DeploymentExecutionService } from "./deployment-execution.service";

type PrivateRegistryExecution = {
  applyWithScopedRegistryAuth: (
    snapshot: object,
    params: { stackName: string; renderedStack: string; artifactSha256: string; appGroupId: string },
  ) => Promise<{ exitCode: number }>;
};
const tenantId = "11111111-1111-4111-8111-111111111111";
const params = {
  stackName: "rp_11111111",
  renderedStack: "services: {}",
  artifactSha256: "a".repeat(64),
  appGroupId: "22222222-2222-4222-8222-222222222222",
};

function fixture() {
  const prisma = {
    registry: { findMany: vi.fn().mockResolvedValue([{
      id: "registry-1", tenantId,
      host: "registry.example.com",
      authType: RegistryAuthType.Token,
      username: "tenant-user",
      credentialData: { valueCiphertext: "encrypted" },
    }]) },
  };
  const stackApplyService = {
    applyStack: vi.fn().mockResolvedValue({ exitCode: 0 }),
  };
  const stackRegistryAuth = {
    withScopedLogin: vi.fn(async (
      targets: object[],
      action: (dockerConfigPath: string) => Promise<unknown>,
    ) => ({
      auth: { success: true, message: "OK", details: "" },
      result: await action("/tmp/tenant-scoped-auth"),
    })),
  };
  const service = Object.assign(Object.create(DeploymentExecutionService.prototype), {
    prisma, stackApplyService, stackRegistryAuth,
    encryption: { decrypt: vi.fn().mockReturnValue("sensitive-token") },
  }) as PrivateRegistryExecution;
  return { service, prisma, stackApplyService, stackRegistryAuth };
}

describe("Worker deployment uses only tenant-scoped registry auth (#218)", () => {
  it("selects registries under the tenant ID and forwards the same temporary config to stack deploy", async () => {
    const f = fixture();
    const snapshot = { appGroup: { tenantId }, singleApps: [{ registryId: "registry-1" }] };
    await expect(f.service.applyWithScopedRegistryAuth(snapshot, params))
      .resolves.toMatchObject({ exitCode: 0 });
    expect(f.prisma.registry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["registry-1"] }, tenantId },
    }));
    expect(f.stackRegistryAuth.withScopedLogin).toHaveBeenCalledWith(
      [expect.objectContaining({ credential: "sensitive-token", host: "registry.example.com" })],
      expect.any(Function),
    );
    expect(f.stackApplyService.applyStack).toHaveBeenCalledWith({
      ...params, dockerConfigPath: "/tmp/tenant-scoped-auth",
    });
  });

  it("fails closed when the requested registry belongs to another tenant", async () => {
    const f = fixture();
    f.prisma.registry.findMany.mockResolvedValue([]);
    const result = await f.service.applyWithScopedRegistryAuth(
      { appGroup: { tenantId }, singleApps: [{ registryId: "registry-1" }] }, params,
    );
    expect(result.exitCode).not.toBe(0);
    expect(f.stackApplyService.applyStack).not.toHaveBeenCalled();
    expect(f.stackRegistryAuth.withScopedLogin).not.toHaveBeenCalled();
  });

  it("still isolates deployments that use no configured private registry", async () => {
    const f = fixture();
    await expect(f.service.applyWithScopedRegistryAuth(
      { appGroup: { tenantId }, singleApps: [{ registryId: null }] }, params,
    )).resolves.toMatchObject({ exitCode: 0 });
    expect(f.stackRegistryAuth.withScopedLogin).toHaveBeenCalledWith([], expect.any(Function));
    expect(f.stackApplyService.applyStack).toHaveBeenCalledWith(expect.objectContaining({
      dockerConfigPath: "/tmp/tenant-scoped-auth",
    }));
  });
});
