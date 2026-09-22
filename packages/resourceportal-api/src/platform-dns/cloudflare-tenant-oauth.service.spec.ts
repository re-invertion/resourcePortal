import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/types";
import type { PrismaService } from "../prisma/prisma.service";
import type { EncryptionService } from "../security/encryption.service";
import {
  CloudflareApiError,
  type CloudflareDnsService,
} from "./cloudflare-dns.service";
import { CloudflareTenantOauthService } from "./cloudflare-tenant-oauth.service";
import type { ManagedDnsService } from "./managed-dns.service";

const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "user@example.com",
  displayName: "User",
  status: "Active",
} as unknown as AuthenticatedUser;
const tenantId = "22222222-2222-4222-8222-222222222222";
type StateCreateCall = {
  data: { tenantId: string; userId: string; stateHash: string };
};
type ConnectionUpsertCall = {
  create: {
    accessTokenCiphertext: string;
    refreshTokenCiphertext: string | null;
    scopes: string[];
  };
};
const oauthConfig = {
  clientId: "cloudflare-client",
  clientSecret: "cloudflare-secret",
  redirectUri: "https://resource-portal.pl/api/integrations/cloudflare/oauth/callback",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function fixture() {
  const stateCreate = vi.fn().mockResolvedValue({});
  const stateFindUnique = vi.fn();
  const connectionFindUnique = vi.fn();
  const connectionUpsert = vi.fn().mockResolvedValue({});
  const tx = {
    cloudflareOAuthState: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    cloudflareOAuthConnection: {
      upsert: connectionUpsert,
    },
  };
  const prisma = {
    cloudflareOAuthState: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: stateCreate,
      findUnique: stateFindUnique,
    },
    cloudflareOAuthConnection: {
      findUnique: connectionFindUnique,
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };
  const encryption = {
    encrypt: vi.fn((value: string) => `cipher:${value}`),
    decrypt: vi.fn((value: string) => value.replace(/^cipher:/, "")),
  };
  const cloudflare = {
    listZones: vi.fn().mockResolvedValue([]),
    ensureVerificationTxt: vi.fn().mockResolvedValue({}),
  };
  const managedDns = {
    getTenantOauthConfiguration: vi.fn().mockResolvedValue(oauthConfig),
    getPlatformState: vi.fn().mockResolvedValue({
      tenantOauthConfigured: true,
    }),
  };
  return {
    prisma,
    stateCreate,
    stateFindUnique,
    connectionFindUnique,
    connectionUpsert,
    tx,
    encryption,
    cloudflare,
    managedDns,
    service: new CloudflareTenantOauthService(
      prisma as unknown as PrismaService,
      encryption as unknown as EncryptionService,
      cloudflare as unknown as CloudflareDnsService,
      managedDns as unknown as ManagedDnsService,
    ),
  };
}

describe("CloudflareTenantOauthService", () => {
  it("stores only a hash of OAuth state and requests the minimum DNS scopes", async () => {
    const f = fixture();
    const result = await f.service.startAuthorization(tenantId, actor);
    const url = new URL(result.authorizationUrl);
    const rawState = url.searchParams.get("state");

    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(url.searchParams.get("client_id")).toBe(oauthConfig.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(oauthConfig.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "zone.read",
      "dns.write",
      "offline_access",
    ]);
    expect(rawState).toBeTruthy();

    const stateCreateCall = f.stateCreate.mock.calls[0]?.[0] as StateCreateCall;
    const stored = stateCreateCall.data;
    expect(stored.tenantId).toBe(tenantId);
    expect(stored.userId).toBe(actor.id);
    expect(stored.stateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.stateHash).not.toBe(rawState);
  });

  it("exchanges a one-time state and stores access and refresh tokens encrypted", async () => {
    const f = fixture();
    const started = await f.service.startAuthorization(tenantId, actor);
    const rawState = new URL(started.authorizationUrl).searchParams.get("state")!;
    const stateRow = {
      id: "33333333-3333-4333-8333-333333333333",
      tenantId,
      userId: actor.id,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    };
    f.stateFindUnique.mockResolvedValue(stateRow);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "access-secret",
            refresh_token: "refresh-secret",
            expires_in: 3600,
            scope: "zone.read dns.write offline_access",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(
      f.service.completeAuthorization("authorization-code", rawState, actor),
    ).resolves.toEqual({ tenantId });

    const upsert = f.connectionUpsert.mock.calls[0]?.[0] as ConnectionUpsertCall;
    expect(upsert.create.accessTokenCiphertext).toBe("cipher:access-secret");
    expect(upsert.create.refreshTokenCiphertext).toBe("cipher:refresh-secret");
    expect(upsert.create.scopes).toEqual([
      "zone.read",
      "dns.write",
      "offline_access",
    ]);
    expect(f.tx.cloudflareOAuthState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: stateRow.id, consumedAt: null },
      }),
    );
  });

  it("rejects OAuth state that belongs to another user", async () => {
    const f = fixture();
    f.stateFindUnique.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      tenantId,
      userId: "99999999-9999-4999-8999-999999999999",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });

    await expect(
      f.service.completeAuthorization("code", "state", actor),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("maps Cloudflare permission failures to an actionable 400", async () => {
    const f = fixture();
    f.connectionFindUnique.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      tenantId,
      userId: actor.id,
      accessTokenCiphertext: "cipher:access-secret",
      refreshTokenCiphertext: null,
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000),
      scopes: ["zone.read", "dns.write"],
    });
    f.cloudflare.listZones.mockRejectedValue(
      new CloudflareApiError("Cloudflare OAuth token lacks Zone Read", "configuration"),
    );

    await expect(f.service.listZones(tenantId, actor.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
