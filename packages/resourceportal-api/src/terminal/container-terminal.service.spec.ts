import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../prisma/prisma.service";
import { ContainerTerminalService } from "./container-terminal.service";

const tenant = "11111111-1111-4111-8111-111111111111";
const group = "22222222-2222-4222-8222-222222222222";
const app = "33333333-3333-4333-8333-333333333333";
const actorId = "44444444-4444-4444-8444-444444444444";
const actor = { id: actorId, displayName: "Admin", email: "admin@example.test" } as never;
function setup(found: { name: string } | null = { name: "app" }) {
  const prisma = { singleApp: { findFirst: vi.fn().mockResolvedValue(found) }, tenant: { findUnique: vi.fn().mockResolvedValue({ name: "Tenant" }) }, auditLogEntry: { create: vi.fn().mockResolvedValue({}) } };
  const config = { get: vi.fn((key: string) => key === "INTERNAL_WORKER_TOKEN" ? "test-worker-secret" : undefined) };
  return { prisma, service: new ContainerTerminalService(prisma as unknown as PrismaService, config as unknown as ConfigService) };
}
afterEach(() => vi.unstubAllGlobals());
describe("tenant container terminal boundary", () => {
  it("never forwards an unowned app to the runtime", async () => {
    const { service, prisma } = setup(null);
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(service.call(tenant, group, app, actor, "start")).rejects.toThrow("Application not found");
    expect(prisma.singleApp.findFirst).toHaveBeenCalledWith({ where: { id: app, appGroupId: group, appGroup: { tenantId: tenant } }, select: { name: true } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("binds worker session to tenant app and actor, not caller-provided service or identity", async () => {
    const { service, prisma } = setup();
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: "55555555-5555-4555-8555-555555555555", container: "a".repeat(12) }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await service.call(tenant, group, app, actor, "start", { service: "unauthorized", actor: "forged" });
    const body = JSON.parse(String(fetcher.mock.calls[0][1].body));
    expect(body).toMatchObject({ action: "start", service: `rp_${group.replaceAll("-", "_")}_app` });
    expect(body.actor).toMatch(/^[a-f0-9]{64}$/);
    expect(body.actor).not.toBe(actorId);
    expect(prisma.auditLogEntry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "singleapp.terminal.start", resourceId: app }) }));
  });
  it("rejects invalid input and never forwards oversized interactive writes", async () => {
    const { service } = setup();
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(service.call(tenant, group, app, actor, "write", { sessionId: "55555555-5555-4555-8555-555555555555", input: "x".repeat(8193) })).rejects.toThrow("8 KiB");
    await expect(service.call(tenant, group, app, actor, "resize", { sessionId: "55555555-5555-4555-8555-555555555555", cols: 999, rows: 20 })).rejects.toThrow("dimensions");
    await expect(service.call(tenant, group, app, actor, "execute", { command: "z".repeat(4097) })).rejects.toThrow("4096");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
