import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import type { OperationsService } from "../operations/operations.service";
import { PlatformReleaseService, classifyReleaseRollback } from "./platform-release.service";

describe("PlatformReleaseService", () => {
  it("reports current/latest version and rollback capability from the release manifest", async () => {
    const config = {
      get: vi.fn((key: string) => {
        if (key === "RESOURCEPORTAL_VERSION") return "0.2.66";
        return undefined;
      }),
    };
    const operations = { enqueue: vi.fn() };
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (url.endsWith("/releases/latest")) {
        return new Response(JSON.stringify({
          tag_name: "v0.2.67",
          assets: [{
            name: "resourceportal-release-manifest.json",
            browser_download_url: "https://github.com/re-invertion/resourcePortal/releases/download/v0.2.67/resourceportal-release-manifest.json",
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        version: "0.2.67",
        migrations: { rollbackPolicy: "image-only" },
      }), { status: 200 });
    }));

    const service = new PlatformReleaseService(
      config as unknown as ConfigService,
      operations as unknown as OperationsService,
    );
    await expect(service.status()).resolves.toMatchObject({
      currentVersion: "0.2.66",
      latestVersion: "0.2.67",
      updateAvailable: true,
      rollbackPolicy: "image-only",
      automaticRollbackAvailable: true,
    });
    vi.unstubAllGlobals();
  });

  it("verifies the target release before queuing a platform update", async () => {
    const config = {
      get: vi.fn((key: string) => key === "RESOURCEPORTAL_VERSION" ? "0.2.66" : undefined),
    };
    const operations = {
      enqueue: vi.fn().mockResolvedValue({ id: "op1", status: "Pending" }),
    };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      tag_name: "v0.2.67",
      assets: [{
        name: "resourceportal-release-manifest.json",
        browser_download_url: "https://github.com/re-invertion/resourcePortal/releases/download/v0.2.67/resourceportal-release-manifest.json",
      }],
    }), { status: 200 }))));
    const service = new PlatformReleaseService(
      config as unknown as ConfigService,
      operations as unknown as OperationsService,
    );
    const actor = { id: "user1", email: "admin@example.test", displayName: "Admin" } as never;

    await service.requestUpdate(
      { targetVersion: "0.2.67", confirmation: "AKTUALIZUJ" },
      actor,
    );

    expect(operations.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: "PLATFORM_RELEASE_UPDATE",
      resourceType: "PlatformRelease",
      idempotencyKey: "platform-release-update:0.2.67",
      input: {
        targetVersion: "0.2.67",
        manifestUrl: "https://github.com/re-invertion/resourcePortal/releases/download/v0.2.67/resourceportal-release-manifest.json",
      },
    }));
    vi.unstubAllGlobals();
  });

  it("rejects downgrade or same-version update requests", async () => {
    const config = { get: vi.fn(() => "0.2.66") };
    const service = new PlatformReleaseService(
      config as unknown as ConfigService,
      { enqueue: vi.fn() } as unknown as OperationsService,
    );
    const actor = { id: "user1" } as never;

    await expect(service.requestUpdate(
      { targetVersion: "0.2.66", confirmation: "AKTUALIZUJ" },
      actor,
    )).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("release rollback safety classification", () => {
  const hash = "a".repeat(40);
  const manifest = {
    version: "0.2.76",
    migrations: {
      rollbackPolicy: "image-only",
      rollbackAssessment: {
        reason: "no-resourceportal-database-schema-changes",
        sourceVersion: "0.2.75",
        targetCommit: hash,
      },
    },
  };
  it("permits image-only solely from attested source release", () => {
    expect(classifyReleaseRollback(manifest, "0.2.76", "0.2.75")).toMatchObject({
      automaticRollbackAvailable: true, rollbackReason: "available",
    });
    expect(classifyReleaseRollback(manifest, "0.2.76", "0.2.74")).toMatchObject({
      automaticRollbackAvailable: false, rollbackReason: "source-version-not-verified",
    });
  });
  it("disallows unverifiable tested claims and inconsistent manifests", () => {
    expect(classifyReleaseRollback({ ...manifest, migrations: { rollbackPolicy: "tested" } },
      "0.2.76", "0.2.75").rollbackReason).toBe("tested-evidence-missing");
    expect(classifyReleaseRollback(manifest, "0.2.77", "0.2.75").rollbackReason).toBe("manifest-invalid");
    expect(classifyReleaseRollback({ ...manifest, migrations: { rollbackPolicy: "none" } },
      "0.2.76", "0.2.75").rollbackReason).toBe("policy-disallows-rollback");
  });
  it("separates missing and unreadable release manifests", async () => {
    const config = { get: vi.fn((key: string) => key === "RESOURCEPORTAL_VERSION" ? "0.2.75" : undefined) };
    const service = new PlatformReleaseService(config as unknown as ConfigService,
      { enqueue: vi.fn() } as unknown as OperationsService);
    vi.stubGlobal("fetch", vi.fn((input: string) => {
      if (input.endsWith("/releases/latest")) {
        return new Response(JSON.stringify({ tag_name: "v0.2.76", assets: [] }), { status: 200 });
      }
      return new Response("blocked", { status: 503 });
    }));
    expect(await service.status()).toMatchObject({ rollbackReason: "manifest-missing" });
    vi.stubGlobal("fetch", vi.fn((input: string) => {
      if (input.endsWith("/releases/latest")) {
        return new Response(JSON.stringify({ tag_name: "v0.2.76",
          assets: [{ name: "resourceportal-release-manifest.json", browser_download_url: "https://test.invalid/manifest" }] }), { status: 200 });
      }
      return new Response("blocked", { status: 503 });
    }));
    expect(await service.status()).toMatchObject({ rollbackReason: "manifest-unavailable" });
    vi.unstubAllGlobals();
  });
});
