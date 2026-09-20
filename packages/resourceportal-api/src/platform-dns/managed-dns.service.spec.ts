import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DomainType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import type { EncryptionService } from "../security/encryption.service";
import {
  CloudflareApiError,
  CloudflareDnsRecordConflictError,
  type CloudflareDnsService,
} from "./cloudflare-dns.service";
import { ManagedDnsService } from "./managed-dns.service";
import { PLATFORM_DNS_INTEGRATION_ID } from "./platform-dns.constants";

const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  displayName: "Admin",
  status: "Active",
} as const;

function fixture(overrides: Record<string, unknown> = {}) {
  let state = {
    id: PLATFORM_DNS_INTEGRATION_ID,
    provider: "Cloudflare",
    enabled: false,
    zoneId: null as string | null,
    zoneName: null as string | null,
    apiTokenCiphertext: null as string | null,
    lastValidatedAt: null as Date | null,
    lastError: null as string | null,
    updatedBy: null as string | null,
    createdAt: new Date("2026-09-20T12:00:00Z"),
    updatedAt: new Date("2026-09-20T12:00:00Z"),
    ...overrides,
  };
  const update = vi.fn(
    ({ data }: { data: Record<string, unknown> }) => {
      state = {
        ...state,
        ...Object.fromEntries(
          Object.entries(data).filter(([, value]) => value !== undefined),
        ),
        updatedAt: new Date(),
      };
      return Promise.resolve(state);
    },
  );
  const tx = {
    platformDnsIntegration: { update },
    auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    platformDnsIntegration: {
      upsert: vi.fn().mockImplementation(() => Promise.resolve(state)),
      update,
    },
    domain: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi
      .fn()
      .mockImplementation(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
  };
  const config = {
    get: vi.fn((key: string, fallback?: string) =>
      key === "MANAGED_DOMAIN_BASE"
        ? "apps.resource-portal.pl"
        : key === "RESOURCEPORTAL_PUBLIC_HOSTNAME"
          ? "resource-portal.pl"
          : fallback,
    ),
  };
  const encryption = {
    encrypt: vi.fn((value: string) => `enc:${value}`),
    decrypt: vi.fn((value: string) => value.replace(/^enc:/, "")),
  };
  const cloudflare = {
    validateConnection: vi.fn().mockResolvedValue({
      zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      zoneName: "resource-portal.pl",
    }),
    ensureManagedCname: vi.fn().mockResolvedValue({
      created: true,
      record: { id: "record-1" },
    }),
    deleteManagedCname: vi.fn().mockResolvedValue({ deleted: 1 }),
    hasManagedCname: vi.fn().mockResolvedValue(true),
  };
  return {
    prisma,
    cloudflare,
    service: new ManagedDnsService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      encryption as unknown as EncryptionService,
      cloudflare as unknown as CloudflareDnsService,
    ),
  };
}

describe("ManagedDnsService", () => {
  it("keeps tenant managed domains unavailable until Cloudflare is configured, validated and enabled", async () => {
    const { service } = fixture();
    await expect(service.getTenantCapabilities()).resolves.toEqual({
      managedDomains: {
        enabled: false,
        provider: "Cloudflare",
        baseDomain: "apps.resource-portal.pl",
      },
    });
    await expect(
      service.provisionManagedDomain("app.apps.resource-portal.pl"),
    ).rejects.toThrow("disabled by the Platform Administrator");
  });

  it("validates Cloudflare and reconciles existing managed domains before enabling the tenant capability", async () => {
    const { service, prisma, cloudflare } = fixture();
    prisma.domain.findMany.mockResolvedValue([
      { hostname: "legacy.apps.resource-portal.pl" },
    ]);

    const result = await service.updatePlatformState(
      {
        enabled: true,
        zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        apiToken: "cloudflare-token-that-is-long-enough",
      },
      actor,
    );

    expect(cloudflare.validateConnection).toHaveBeenCalledWith({
      apiToken: "cloudflare-token-that-is-long-enough",
      zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      managedBaseDomain: "apps.resource-portal.pl",
    });
    expect(cloudflare.ensureManagedCname).toHaveBeenCalledWith({
      apiToken: "cloudflare-token-that-is-long-enough",
      zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      hostname: "legacy.apps.resource-portal.pl",
      targetHostname: "resource-portal.pl",
    });
    expect(result).toMatchObject({
      enabled: true,
      available: true,
      tokenConfigured: true,
      zoneName: "resource-portal.pl",
    });
    expect(result).not.toHaveProperty("apiToken");
    expect(result).not.toHaveProperty("apiTokenCiphertext");
  });

  it("does not allow switching Cloudflare zones while managed domains still exist", async () => {
    const { service, prisma } = fixture({
      zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      apiTokenCiphertext: "enc:old-token",
      enabled: true,
      lastValidatedAt: new Date(),
    });
    prisma.domain.count.mockResolvedValue(1);
    await expect(
      service.updatePlatformState(
        { zoneId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        actor,
      ),
    ).rejects.toThrow(
      "cannot be changed while managed ResourcePortal domains exist",
    );
    expect(prisma.domain.count).toHaveBeenCalledWith({
      where: { type: DomainType.Managed },
    });
  });

  it("returns an actionable 409 when an existing Cloudflare record blocks reconciliation", async () => {
    const { service, prisma, cloudflare } = fixture();
    prisma.domain.findMany.mockResolvedValue([
      { hostname: "design.portal.resource-portal.pl" },
    ]);
    cloudflare.ensureManagedCname.mockRejectedValue(
      new CloudflareDnsRecordConflictError(
        "design.portal.resource-portal.pl",
        [
          {
            id: "legacy-a",
            type: "A",
            name: "design.portal.resource-portal.pl",
            content: "109.206.199.72",
          },
        ],
      ),
    );

    try {
      await service.updatePlatformState(
        {
          enabled: true,
          zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          apiToken: "cloudflare-token-that-is-long-enough",
        },
        actor,
      );
      throw new Error("Expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      const conflict = error as ConflictException;
      expect(conflict.getStatus()).toBe(409);
      const response = conflict.getResponse() as {
        code?: unknown;
        message?: unknown;
        details?: {
          hostname?: unknown;
          existingRecords?: Array<{ type?: unknown; content?: unknown }>;
        };
      };
      expect(response.code).toBe("CloudflareDnsRecordConflict");
      expect(response.message).toContain("design.portal.resource-portal.pl");
      expect(response.details).toEqual({
        hostname: "design.portal.resource-portal.pl",
        existingRecords: [{ type: "A", content: "109.206.199.72" }],
      });
    }
    const updateCall = prisma.platformDnsIntegration.update.mock.calls.at(-1)?.[0] as
      | { data?: { lastError?: unknown } }
      | undefined;
    expect(updateCall?.data?.lastError).toContain(
      "design.portal.resource-portal.pl",
    );
  });

  it("returns a readable 400 for Cloudflare configuration errors", async () => {
    const { service, cloudflare } = fixture();
    cloudflare.validateConnection.mockRejectedValue(
      new CloudflareApiError("Cloudflare API token is invalid", "configuration"),
    );

    await expect(
      service.updatePlatformState(
        {
          enabled: true,
          zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          apiToken: "cloudflare-token-that-is-long-enough",
        },
        actor,
      ),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      response: {
        code: "CloudflareConfigurationError",
        message: "Cloudflare API token is invalid",
      },
    });
  });

  it("returns a readable 502 when Cloudflare itself is unavailable", async () => {
    const { service, cloudflare } = fixture();
    cloudflare.validateConnection.mockRejectedValue(
      new CloudflareApiError("Cloudflare API request failed: timeout", "upstream"),
    );

    await expect(
      service.updatePlatformState(
        {
          enabled: true,
          zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          apiToken: "cloudflare-token-that-is-long-enough",
        },
        actor,
      ),
    ).rejects.toMatchObject({
      constructor: BadGatewayException,
      response: {
        code: "CloudflareUpstreamError",
        message: "Cloudflare API request failed: timeout",
      },
    });
  });

});
