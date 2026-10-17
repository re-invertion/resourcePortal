import { ForbiddenException } from "@nestjs/common";
import { UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import type { AuthenticatedUser } from "../auth/types";
import { TenantOidcController } from "./tenant-oidc.controller";
import type { TenantOidcAuditService } from "./tenant-oidc-audit.service";
import type { TenantOidcService } from "./tenant-oidc.service";

const actor: AuthenticatedUser = {
  id: "admin-1", email: "admin@example.com",
  displayName: "Admin", status: UserStatus.Active,
};
function fixture() {
  const service = {
    provision: vi.fn().mockResolvedValue({ enabled: false }),
    activate: vi.fn().mockRejectedValue(new Error("activation blocked")),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const controller = new TenantOidcController(
    service as unknown as TenantOidcService,
    audit as unknown as TenantOidcAuditService,
  );
  return { service, audit, controller };
}

describe("Tenant OIDC mutation audit boundaries", () => {
  it("requires a logged-in human administrator even if invoked directly", async () => {
    const f = fixture();
    await expect(f.controller.provision("tenant-a", undefined as unknown as AuthenticatedUser))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(f.service.provision).not.toHaveBeenCalled();
  });

  it("rejects service identities even with tenant-admin OAuth permissions", async () => {
    const f = fixture();
    const machineActor: AuthenticatedUser = { ...actor, id: "machine-1" };
    const request = {
      serviceIdentity: { id: "machine-1", tenantId: "tenant-a", name: "machine", status: "Active" },
      tenantContext: { tenantId: "tenant-a", serviceIdentityId: "machine-1", permissions: [
        "oauth_application.create", "oauth_application.update", "oauth_application.delete",
      ] },
    } as unknown as FastifyRequest;
    await expect(f.controller.provision("tenant-a", machineActor, request)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.controller.activate("tenant-a", machineActor, request)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.controller.disable("tenant-a", machineActor, request)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.controller.delete("tenant-a", machineActor, request)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.controller.reconcileGrants("tenant-a", machineActor, request)).rejects.toBeInstanceOf(ForbiddenException);
    expect(() => f.controller.get("tenant-a", request)).toThrow(ForbiddenException);
    expect(f.service.provision).not.toHaveBeenCalled();
    expect(f.service.activate).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
  });

  it("fails closed when the service context exists without a separate serviceIdentity marker", async () => {
    const f = fixture();
    const request = { tenantContext: { tenantId: "tenant-a", serviceIdentityId: "machine-1" } } as unknown as FastifyRequest;
    await expect(f.controller.provision("tenant-a", actor, request)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("records a successful tenant-scoped action", async () => {
    const f = fixture();
    await expect(f.controller.provision("tenant-a", actor)).resolves.toMatchObject({
      enabled: false,
    });
    expect(f.service.provision).toHaveBeenCalledWith("tenant-a");
    expect(f.audit.record).toHaveBeenCalledWith("tenant-a", actor, "provision", "Success");
  });

  it("preserves the original failure while attempting a failure audit", async () => {
    const f = fixture();
    await expect(f.controller.activate("tenant-a", actor)).rejects.toThrow("activation blocked");
    expect(f.audit.record).toHaveBeenCalledWith("tenant-a", actor, "activate", "Failed");
  });
});
