import {
  RegistryAuthType,
  RegistryTlsMode,
  RegistryValidationStatus,
} from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import { RegistriesService } from "./registries.service";

const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  displayName: "Admin",
  status: "Active",
} as const;

function registry(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: "22222222-2222-4222-8222-222222222222",
    tenantId: "33333333-3333-4333-8333-333333333333",
    name: "registry",
    description: null,
    host: "registry.example.com",
    tlsMode: RegistryTlsMode.TLS,
    authType: RegistryAuthType.None,
    username: null,
    credentialData: null,
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

function serviceFor(item = registry()) {
  const prisma = {
    registry: {
      findFirst: vi.fn().mockResolvedValue(item),
      update: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({ ...item, ...data }),
      ),
    },
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

describe("RegistriesService.validateRegistry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates a TLS registry through /v2/", async () => {
    const { service, prisma } = serviceFor();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );

    const result = await service.validateRegistry(
      "33333333-3333-4333-8333-333333333333",
      "22222222-2222-4222-8222-222222222222",
      actor as never,
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://registry.example.com/v2/",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.validationStatus).toBe(RegistryValidationStatus.Valid);
    expect(prisma.registry.update).toHaveBeenLastCalledWith({
      where: { id: "22222222-2222-4222-8222-222222222222" },
      data: expect.objectContaining({
        validationStatus: RegistryValidationStatus.Valid,
        lastValidationError: null,
      }),
    });
  });

  it("uses decrypted basic credentials", async () => {
    const item = registry({
      authType: RegistryAuthType.UsernamePassword,
      username: "alice",
      credentialData: { valueCiphertext: "enc:secret" },
    });
    const { service, encryption } = serviceFor(item);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );

    await service.validateRegistry(item.tenantId, item.id, actor as never);

    expect(encryption.decrypt).toHaveBeenCalledWith("enc:secret");
    expect(fetch).toHaveBeenCalledWith(
      "https://registry.example.com/v2/",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
        }),
      }),
    );
  });

  it("marks non-success registry responses as invalid", async () => {
    const { service } = serviceFor();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );

    const result = await service.validateRegistry(
      "33333333-3333-4333-8333-333333333333",
      "22222222-2222-4222-8222-222222222222",
      actor as never,
    );

    expect(result.validationStatus).toBe(RegistryValidationStatus.Invalid);
    expect(result.lastValidationError).toContain("HTTP 401");
  });

  it("marks transport failures as errors", async () => {
    const { service } = serviceFor();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));

    const result = await service.validateRegistry(
      "33333333-3333-4333-8333-333333333333",
      "22222222-2222-4222-8222-222222222222",
      actor as never,
    );

    expect(result.validationStatus).toBe(RegistryValidationStatus.Error);
    expect(result.lastValidationError).toBe("connection refused");
  });
});
