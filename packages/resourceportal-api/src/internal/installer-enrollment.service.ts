import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InstallerEnrollmentRole } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

export type InstallerEnrollmentBundleRole = "worker" | "manager";

@Injectable()
export class InstallerEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async issue(role: InstallerEnrollmentBundleRole, now = new Date()) {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);

    await this.prisma.installerEnrollment.create({
      data: {
        tokenHash,
        role: toPrismaRole(role),
        expiresAt,
        consumedAt: null,
      },
    });

    return { token, role, expiresAt };
  }

  async redeem(
    token: string,
    requestedRole: InstallerEnrollmentBundleRole,
    now = new Date(),
  ) {
    if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) {
      throw invalidEnrollment();
    }

    const result = await this.prisma.installerEnrollment.updateMany({
      where: {
        tokenHash: hashToken(token),
        role: toPrismaRole(requestedRole),
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });

    if (result.count !== 1) {
      throw invalidEnrollment();
    }

    const joinToken = this.requiredConfig(
      requestedRole === "manager"
        ? "INSTALLER_SWARM_MANAGER_TOKEN"
        : "INSTALLER_SWARM_WORKER_TOKEN",
    );

    return {
      role: requestedRole,
      joinToken,
      managerEndpoint: this.requiredConfig("INSTALLER_SWARM_MANAGER_ENDPOINT"),
      nfsServerAddress: this.requiredConfig("INSTALLER_STORAGE_SERVER_ADDRESS"),
      clusterId: this.requiredConfig("INSTALLER_CLUSTER_ID"),
      installerVersion: this.requiredConfig("INSTALLER_VERSION"),
      swarmAdvertiseAddr: this.requiredConfig("INSTALLER_SWARM_ADVERTISE_ADDR"),
    };
  }

  private requiredConfig(key: string) {
    const value = this.config.get<string>(key);
    if (!value) {
      throw new Error(`Missing installer enrollment configuration: ${key}`);
    }
    return value;
  }
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function toPrismaRole(role: InstallerEnrollmentBundleRole) {
  return role === "manager"
    ? InstallerEnrollmentRole.Manager
    : InstallerEnrollmentRole.Worker;
}

function invalidEnrollment() {
  return new UnauthorizedException(
    "Enrollment token is invalid, expired, consumed, or role-mismatched",
  );
}
