import { UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/types";
import { DomainsController } from "../domains/domains.controller";
import { VolumesController } from "../volumes/volumes.controller";

const actor: AuthenticatedUser = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "actor@example.com",
  displayName: "Actor",
  status: UserStatus.Active,
};

type AsyncVolumesController = {
  createVolume: (
    tenantId: string,
    idempotencyKey: string | undefined,
    dto: unknown,
    user: AuthenticatedUser,
  ) => Promise<unknown>;
};
type AsyncDomainsController = {
  validateDomain: (
    tenantId: string,
    domainId: string,
    idempotencyKey: string | undefined,
    user: AuthenticatedUser,
  ) => Promise<unknown>;
};

describe("Stage 16 async mutation endpoints", () => {
  it("queues Volume create with Idempotency-Key instead of provisioning in the request", async () => {
    const createVolume = vi.fn().mockResolvedValue({ id: "volume-1" });
    const enqueue = vi.fn().mockResolvedValue({ id: "operation-1", status: "Pending" });
    const Constructor = VolumesController as unknown as new (
      volumes: unknown,
      operations: unknown,
    ) => AsyncVolumesController;
    const controller = new Constructor({ createVolume }, { enqueue });

    await controller.createVolume(
      "22222222-2222-4222-8222-222222222222",
      "stage16-volume-create",
      { name: "data", sizeBytes: 1024 },
      actor,
    );

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "VOLUME_CREATE",
        resourceType: "Volume",
        actor,
        idempotencyKey: "stage16-volume-create",
      }),
    );
    expect(createVolume).not.toHaveBeenCalled();
  });

  it("queues Domain verification with Idempotency-Key instead of validating in the request", async () => {
    const validateDomain = vi.fn().mockResolvedValue({ id: "domain-1" });
    const enqueue = vi.fn().mockResolvedValue({ id: "operation-2", status: "Pending" });
    const Constructor = DomainsController as unknown as new (
      domains: unknown,
      operations: unknown,
    ) => AsyncDomainsController;
    const controller = new Constructor({ validateDomain }, { enqueue });

    await controller.validateDomain(
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "stage16-domain-verify",
      actor,
    );

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "DOMAIN_VERIFY",
        resourceType: "Domain",
        actor,
        idempotencyKey: "stage16-domain-verify",
      }),
    );
    expect(validateDomain).not.toHaveBeenCalled();
  });
});
