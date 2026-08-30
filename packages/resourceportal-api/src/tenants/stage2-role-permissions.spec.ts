import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { TenantsService } from "./tenants.service";

describe("Stage 2 role permission API compatibility", () => {
  it("keeps listRoles permissions as string identifiers after normalization", async () => {
    const tenantId = "255d43ba-43fd-49f7-8546-824760045ecd";
    const prisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue({ id: tenantId, name: "tenant-a" }),
      },
      role: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "viewer",
            name: "Viewer",
            permissions: [
              { permission: { id: "tenant.read" } },
              { permission: { id: "appgroup.read" } },
            ],
          },
        ]),
      },
    } as unknown as PrismaService;
    const service = new TenantsService(prisma);

    await expect(service.listRoles(tenantId)).resolves.toEqual([
      {
        id: "viewer",
        name: "Viewer",
        permissions: ["tenant.read", "appgroup.read"],
      },
    ]);
  });
});
