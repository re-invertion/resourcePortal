import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InstallerEnrollmentService } from "./installer-enrollment.service";

type RecordState = {
  tokenHash: string;
  role: "Worker" | "Manager";
  expiresAt: Date;
  consumedAt: Date | null;
  completedAt?: Date | null;
  nodeId?: string | null;
};

function fixture() {
  const records: RecordState[] = [];
  const prisma = {
    installerEnrollment: {
      create: async ({ data }: { data: RecordState }) => {
        records.push({ ...data });
        return { id: "enrollment-1", ...data };
      },
      updateMany: async ({ where, data }: any) => {
        const match = records.find((record) => {
          if (record.tokenHash !== where.tokenHash || record.role !== where.role) return false;
          if (where.consumedAt === null && record.consumedAt !== null) return false;
          if (where.consumedAt?.gt && (!record.consumedAt || record.consumedAt <= where.consumedAt.gt)) return false;
          if (where.expiresAt?.gt && record.expiresAt <= where.expiresAt.gt) return false;
          if (where.completedAt === null && record.completedAt) return false;
          if (where.completedAt instanceof Date && record.completedAt?.getTime() !== where.completedAt.getTime()) return false;
          if (where.nodeId !== undefined && record.nodeId !== where.nodeId) return false;
          return true;
        });
        if (!match) return { count: 0 };
        Object.assign(match, data);
        return { count: 1 };
      },
    },
  };
  const config = {
    get: (key: string) =>
      ({
        INSTALLER_SWARM_WORKER_TOKEN: "SWMTKN-worker-secret",
        INSTALLER_SWARM_MANAGER_TOKEN: "SWMTKN-manager-secret",
        INSTALLER_SWARM_MANAGER_ENDPOINT: "10.20.0.10:2377",
        INSTALLER_STORAGE_SERVER_ADDRESS: "10.20.0.10",
        INSTALLER_CLUSTER_ID: "cluster-abc",
        INSTALLER_VERSION: "0.1.0",
        INSTALLER_SWARM_ADVERTISE_ADDR: "10.20.0.10",
        INSTALLER_CLUSTER_CIDR: "10.20.0.0/24",
      })[key],
  };
  return {
    records,
    service: new InstallerEnrollmentService(prisma as never, config as ConfigService),
  };
}

describe("InstallerEnrollmentService", () => {
  it("issues a 30-minute role-bound token while storing only its SHA-256 hash", async () => {
    const { service, records } = fixture();
    const now = new Date("2026-09-05T12:00:00.000Z");

    const issued = await service.issue("worker", now);

    expect(issued.role).toBe("worker");
    expect(issued.expiresAt.toISOString()).toBe("2026-09-05T12:30:00.000Z");
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(records).toHaveLength(1);
    expect(records[0].role).toBe("Worker");
    expect(records[0].tokenHash).toBe(
      createHash("sha256").update(issued.token).digest("hex"),
    );
    expect(records[0].tokenHash).not.toContain(issued.token);
  });

  it("atomically redeems a valid worker token and returns only worker credentials", async () => {
    const { service } = fixture();
    const issued = await service.issue("worker", new Date("2026-09-05T12:00:00.000Z"));

    const redeemed = await service.redeem(
      issued.token,
      "worker",
      new Date("2026-09-05T12:05:00.000Z"),
    );

    expect(redeemed).toMatchObject({
      role: "worker",
      joinToken: "SWMTKN-worker-secret",
      managerEndpoint: "10.20.0.10:2377",
      nfsServerAddress: "10.20.0.10",
      clusterId: "cluster-abc",
      installerVersion: "0.1.0",
      swarmAdvertiseAddr: "10.20.0.10",
      clusterCidr: "10.20.0.0/24",
    });
    expect(redeemed.joinToken).not.toBe("SWMTKN-manager-secret");
  });

  it("rejects a role-tampered worker token", async () => {
    const { service } = fixture();
    const issued = await service.issue("worker", new Date("2026-09-05T12:00:00.000Z"));

    await expect(
      service.redeem(issued.token, "manager", new Date("2026-09-05T12:05:00.000Z")),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects an expired token", async () => {
    const { service } = fixture();
    const issued = await service.issue("manager", new Date("2026-09-05T12:00:00.000Z"));

    await expect(
      service.redeem(issued.token, "manager", new Date("2026-09-05T12:30:00.001Z")),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("claims completion for exactly one recently redeemed node", async () => {
    const { service, records } = fixture();
    const issued = await service.issue("worker", new Date("2026-09-05T12:00:00.000Z"));
    await service.redeem(issued.token, "worker", new Date("2026-09-05T12:05:00.000Z"));

    const claim = await service.claimCompletion(
      issued.token,
      "worker",
      "abcdefghijklmnopqrstuvwxy",
      new Date("2026-09-05T12:06:00.000Z"),
    );

    expect(claim.role).toBe("worker");
    expect(records[0].nodeId).toBe("abcdefghijklmnopqrstuvwxy");
    await expect(
      service.claimCompletion(
        issued.token,
        "worker",
        "zyxwvutsrqponmlkjihgfedcb",
        new Date("2026-09-05T12:06:01.000Z"),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("can release a failed completion claim for the same node", async () => {
    const { service, records } = fixture();
    const issued = await service.issue("manager", new Date("2026-09-05T12:00:00.000Z"));
    await service.redeem(issued.token, "manager", new Date("2026-09-05T12:05:00.000Z"));
    const claim = await service.claimCompletion(
      issued.token,
      "manager",
      "abcdefghijklmnopqrstuvwxy",
      new Date("2026-09-05T12:06:00.000Z"),
    );

    await service.releaseCompletionClaim(
      issued.token,
      "manager",
      "abcdefghijklmnopqrstuvwxy",
      claim.completedAt,
    );

    expect(records[0].completedAt).toBeNull();
    expect(records[0].nodeId).toBeNull();
  });

  it("rejects token reuse after successful redemption", async () => {
    const { service } = fixture();
    const issued = await service.issue("manager", new Date("2026-09-05T12:00:00.000Z"));
    await service.redeem(issued.token, "manager", new Date("2026-09-05T12:05:00.000Z"));

    await expect(
      service.redeem(issued.token, "manager", new Date("2026-09-05T12:06:00.000Z")),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
