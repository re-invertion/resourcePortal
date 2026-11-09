import "reflect-metadata";
import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { REQUIRED_PERMISSIONS_KEY } from "../auth/auth.constants";
import type { AuthenticatedUser } from "../auth/types";
import { DomainsController } from "./domains.controller";

const tenant = "11111111-1111-4111-8111-111111111111";
const domain = "22222222-2222-4222-8222-222222222222";
const actor = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "tenant@example.com",
  displayName: "Tenant",
} as AuthenticatedUser;

function fixture() {
  const domainsService = {
    getDomain: vi.fn().mockResolvedValue({ id: domain, tenantId: tenant }),
    getCertificateDiagnostics: vi.fn().mockResolvedValue({ certificateStatus: "Error" }),
  };
  const operationsService = {
    enqueue: vi.fn().mockResolvedValue({ id: "queued", status: "Pending" }),
  };
  return {
    ctrl: new DomainsController(domainsService as never, operationsService as never, {} as never),
    domainsService, operationsService,
  };
}

describe("tenant-managed certificate diagnostics and recovery controller", () => {
  it("requires separate read and validate permissions", () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, DomainsController.prototype.certificateDiagnostics)).toEqual(["domain.read"]);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, DomainsController.prototype.reconcileCertificate)).toEqual(["domain.validate"]);
  });

  it("scopes diagnostics and queued reconcile to the authorized tenant domain", async () => {
    const x = fixture();
    expect(await x.ctrl.certificateDiagnostics(tenant, domain)).toMatchObject({ certificateStatus: "Error" });
    await x.ctrl.reconcileCertificate(tenant, domain, actor);
    expect(x.domainsService.getCertificateDiagnostics).toHaveBeenCalledWith(tenant, domain);
    expect(x.domainsService.getDomain).toHaveBeenCalledWith(tenant, domain);
    expect(x.operationsService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: tenant, resourceId: domain, actor,
      type: "DOMAIN_CERTIFICATE_RECONCILE", maxAttempts: 1,
      idempotencyKey: expect.stringMatching(/^tls-reconcile:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333:\d+$/),
    }));
  });

  it("rejects unowned domain before it can queue an observation", async () => {
    const x = fixture();
    x.domainsService.getDomain.mockRejectedValue(new ForbiddenException("NotOwned"));
    await expect(x.ctrl.reconcileCertificate(tenant, domain, actor)).rejects.toThrow("NotOwned");
    expect(x.operationsService.enqueue).not.toHaveBeenCalled();
  });

  it("reuses the same per-domain idempotency key within the five-minute bucket", async () => {
    const x = fixture();
    await x.ctrl.reconcileCertificate(tenant, domain, actor);
    await x.ctrl.reconcileCertificate(tenant, domain, actor);
    const calls = x.operationsService.enqueue.mock.calls.map(([v]) => v.idempotencyKey);
    expect(calls[0]).toBe(calls[1]);
  });
});
