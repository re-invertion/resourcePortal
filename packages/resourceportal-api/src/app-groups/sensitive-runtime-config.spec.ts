import { ConflictException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AppGroupsService } from "./app-groups.service";

function service() {
  return new AppGroupsService(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
}

function draft(environment: Record<string, string>, variableTarget?: string) {
  return {
    id: "group-1",
    tenantId: "tenant-1",
    name: "group",
    hasPendingChanges: true,
    networkPrivileged: false,
    singleApps: [
      {
        name: "api",
        pendingDeletion: false,
        environment,
        variableAttachments: variableTarget
          ? [{ targetName: variableTarget, variable: { value: "value" } }]
          : [],
        httpEndpoints: [],
        internalPortExposures: [],
      },
    ],
  };
}

describe("AppGroupsService sensitive runtime config gate", () => {
  it("rejects secret-like direct environment keys", () => {
    const subject = service() as unknown as {
      assertDraftCanBeDeployed: (draft: unknown, force: boolean) => void;
    };
    expect(() =>
      subject.assertDraftCanBeDeployed(
        draft({ POSTGRES_PASSWORD: "plaintext", LOG_LEVEL: "info" }),
        false,
      ),
    ).toThrow(ConflictException);
  });

  it("rejects secret-like Variable targets", () => {
    const subject = service() as unknown as {
      assertDraftCanBeDeployed: (draft: unknown, force: boolean) => void;
    };
    expect(() =>
      subject.assertDraftCanBeDeployed(draft({}, "API_TOKEN"), false),
    ).toThrow(/ResourcePortal Secrets/);
  });

  it("allows ordinary environment and Variable names", () => {
    const subject = service() as unknown as {
      assertDraftCanBeDeployed: (draft: unknown, force: boolean) => void;
    };
    expect(() =>
      subject.assertDraftCanBeDeployed(draft({ LOG_LEVEL: "info" }, "REGION"), false),
    ).not.toThrow();
  });
});
