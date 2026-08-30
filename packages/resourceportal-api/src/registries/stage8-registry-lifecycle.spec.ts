import {
  RegistryAuthType,
  RegistryTlsMode,
  RegistryValidationStatus,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import { RegistriesService } from "./registries.service";

const tenantId = "33333333-3333-4333-8333-333333333333";
const registryId = "22222222-2222-4222-8222-222222222222";
const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  displayName: "Admin",
  status: "Active",
} as const;

function registry(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: registryId,
    tenantId,
    name: "private",
    description: null,
    host: "registry.example.com",
    tlsMode: RegistryTlsMode.TLS,
    authType: RegistryAuthType.UsernamePassword,
    username: "alice",
    credentialData: { valueCiphertext: "enc:secret" },
    validationStatus: RegistryValidationStatus.Unknown,
    lastValidatedAt: null,
    lastValidationError: null,
    createdBy: actor.id,
    updatedBy: actor.id,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeService(prismaOverrides: Record<string, unknown> = {}) {
  const prisma = {
    registry: {
      findFirst: vi.fn().mockResolvedValue(registry()),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    singleApp: {
      count: vi.fn().mockResolvedValue(0),
    },
    appGroup: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    ...prismaOverrides,
  };
  const encryption = {
    encrypt: vi.fn((value: string) => `enc:${value}`),
    decrypt: vi.fn((value: string) => value.replace(/^enc:/, "")),
  };

  return {
    prisma,
    encryption,
    service: new RegistriesService(
      prisma as unknown as PrismaService,
      encryption as unknown as EncryptionService,
    ),
  };
}

describe("Stage 8 Registry lifecycle", () => {
  it("encrypts credentials before create and never returns credentialData", async () => {
    const { service, prisma, encryption } = makeService();
    prisma.registry.create.mockImplementation(({ data }) =>
      Promise.resolve(registry({
        name: data.name,
        host: data.host,
        authType: data.authType,
        username: data.username,
        credentialData: data.credentialData,
      })),
    );

    const result = await service.createRegistry(
      tenantId,
      {
        name: "private",
        host: "https://REGISTRY.EXAMPLE.COM/team",
        authType: RegistryAuthType.UsernamePassword,
        username: "alice",
        credential: "secret",
      },
      actor,
    );

    expect(encryption.encrypt).toHaveBeenCalledWith("secret");
    expect(prisma.registry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          host: "registry.example.com",
          credentialData: expect.objectContaining({
            valueCiphertext: "enc:secret",
          }),
        }),
      }),
    );
    expect(result).not.toHaveProperty("credentialData");
    expect(result.hasCredential).toBe(true);
  });

  it("blocks deletion while any SingleApp uses the registry", async () => {
    const { service, prisma } = makeService();
    prisma.singleApp.count.mockResolvedValue(1);

    await expect(service.deleteRegistry(tenantId, registryId)).rejects.toThrow(
      "RegistryInUse",
    );
    expect(prisma.registry.delete).not.toHaveBeenCalled();
  });

  it("rejects a registry whose host does not match the image host", async () => {
    const { service } = makeService();

    await expect(
      service.assertRegistryCanBeUsedByImage(
        tenantId,
        registryId,
        "other.example.com/team/app:latest",
      ),
    ).rejects.toThrow();
  });

  it("marks AppGroups using a registry as pending when runtime auth changes", async () => {
    const item = registry();
    const { service, prisma } = makeService();
    prisma.registry.update.mockImplementation(({ data }) =>
      Promise.resolve({ ...item, ...data }),
    );
    prisma.appGroup.findMany.mockResolvedValue([{ id: "app-group-1" }]);
    prisma.appGroup.updateMany.mockResolvedValue({ count: 1 });

    await service.updateRegistry(
      tenantId,
      registryId,
      { credential: "rotated-secret" },
      actor,
    );

    expect(prisma.appGroup.findMany).toHaveBeenCalledWith({
      where: {
        tenantId,
        singleApps: { some: { registryId } },
      },
      select: { id: true },
    });
    expect(prisma.appGroup.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["app-group-1"] } },
      data: {
        hasPendingChanges: true,
        updatedBy: actor.id,
      },
    });
  });
});
