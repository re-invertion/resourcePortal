import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import type { OperationsService } from "../operations/operations.service";
import { PlatformReleaseService } from "./platform-release.service";

describe("PlatformReleaseService", () => {
  it("reports current/latest version and rollback capability from the release manifest", async () => {
    const config = {
      get: vi.fn((key: string) => {
        if (key === "RESOURCEPORTAL_VERSION") return "0.2.66";
        return undefined;
      }),
    };
    const operations = { enqueue: vi.fn() };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
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
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      tag_name: "v0.2.67",
      assets: [{
        name: "resourceportal-release-manifest.json",
        browser_download_url: "https://github.com/re-invertion/resourcePortal/releases/download/v0.2.67/resourceportal-release-manifest.json",
      }],
    }), { status: 200 })));
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
