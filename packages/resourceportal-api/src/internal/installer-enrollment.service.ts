import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { InstallerEnrollmentRole } from "@prisma/client";
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { OperationsRepository } from "../operations/operations.repository";
import type { OperationRecord } from "../operations/operation.types";
import { PrismaService } from "../prisma/prisma.service";

export type InstallerEnrollmentBundleRole = "worker" | "manager";

const ENROLLMENT_SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000001";

@Injectable()
export class InstallerEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationsRepository,
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

  async beginRedemption(
    token: string,
    requestedRole: InstallerEnrollmentBundleRole,
    publicKey: string,
    now = new Date(),
  ) {
    this.assertToken(token);
    this.assertPublicKey(publicKey);

    return this.prisma.$transaction(async (tx) => {
      const result = await tx.installerEnrollment.updateMany({
        where: {
          tokenHash: hashToken(token),
          role: toPrismaRole(requestedRole),
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (result.count !== 1) throw invalidEnrollment();

      const enrollment = await tx.installerEnrollment.findUniqueOrThrow({
        where: { tokenHash: hashToken(token) },
        select: { id: true },
      });
      const operation = await this.operations.createOperationInTransaction(tx, {
        type: "INSTALLER_ENROLLMENT_PREPARE",
        tenantId: null,
        resourceType: "InstallerEnrollment",
        resourceId: enrollment.id,
        createdBy: ENROLLMENT_SYSTEM_ACTOR_ID,
        createdByEmail: "installer-enrollment@resourceportal.internal",
        createdByDisplayName: "Installer enrollment",
        input: { role: requestedRole, publicKey },
        maxAttempts: 3,
      });
      return { status: "pending" as const, role: requestedRole, operationId: operation.id };
    });
  }

  async redemptionStatus(
    token: string,
    requestedRole: InstallerEnrollmentBundleRole,
    operationId: string,
    now = new Date(),
  ) {
    const enrollment = await this.requireRedeemed(token, requestedRole, now);
    const operation = await this.requireEnrollmentOperation(
      enrollment.id,
      operationId,
      "INSTALLER_ENROLLMENT_PREPARE",
    );
    if (operation.status === "Succeeded") {
      const result = this.objectResult(operation);
      return { status: "ready" as const, role: requestedRole, ...result };
    }
    if (operation.status === "Failed" || operation.status === "RollbackFailed") {
      throw new ServiceUnavailableException(
        operation.errorMessage ?? "Enrollment preparation failed",
      );
    }
    return { status: "pending" as const, role: requestedRole, operationId };
  }

  async beginCompletion(
    token: string,
    requestedRole: InstallerEnrollmentBundleRole,
    nodeId: string,
    controlPlane: boolean,
    ingress: boolean,
    now = new Date(),
  ) {
    this.assertToken(token);
    this.assertNodeId(nodeId);

    return this.prisma.$transaction(async (tx) => {
      const result = await tx.installerEnrollment.updateMany({
        where: {
          tokenHash: hashToken(token),
          role: toPrismaRole(requestedRole),
          consumedAt: { not: null },
          expiresAt: { gt: now },
          completedAt: null,
        },
        data: { completedAt: now, nodeId },
      });
      if (result.count !== 1) throw invalidEnrollment();

      const enrollment = await tx.installerEnrollment.findUniqueOrThrow({
        where: { tokenHash: hashToken(token) },
        select: { id: true },
      });
      const operation = await this.operations.createOperationInTransaction(tx, {
        type: "INSTALLER_ENROLLMENT_COMPLETE",
        tenantId: null,
        resourceType: "InstallerEnrollment",
        resourceId: enrollment.id,
        createdBy: ENROLLMENT_SYSTEM_ACTOR_ID,
        createdByEmail: "installer-enrollment@resourceportal.internal",
        createdByDisplayName: "Installer enrollment",
        input: { role: requestedRole, nodeId, controlPlane, ingress },
        maxAttempts: 3,
      });
      return {
        status: "pending" as const,
        role: requestedRole,
        operationId: operation.id,
      };
    });
  }

  async completionStatus(
    token: string,
    requestedRole: InstallerEnrollmentBundleRole,
    nodeId: string,
    operationId: string,
    now = new Date(),
  ) {
    const enrollment = await this.requireCompletionClaim(
      token,
      requestedRole,
      nodeId,
      now,
    );
    const operation = await this.requireEnrollmentOperation(
      enrollment.id,
      operationId,
      "INSTALLER_ENROLLMENT_COMPLETE",
    );
    if (operation.status === "Succeeded") {
      return { status: "completed" as const, role: requestedRole };
    }
    if (operation.status === "Failed" || operation.status === "RollbackFailed") {
      await this.releaseCompletionClaim(token, requestedRole, nodeId);
      throw new ServiceUnavailableException(
        operation.errorMessage ?? "Enrollment completion failed",
      );
    }
    return { status: "pending" as const, role: requestedRole, operationId };
  }

  private async requireRedeemed(
    token: string,
    requestedRole: InstallerEnrollmentBundleRole,
    now: Date,
  ) {
    this.assertToken(token);
    const enrollment = await this.prisma.installerEnrollment.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, role: true, consumedAt: true, expiresAt: true },
    });
    if (
      !enrollment ||
      enrollment.role !== toPrismaRole(requestedRole) ||
      !enrollment.consumedAt ||
      enrollment.expiresAt <= now
    ) {
      throw invalidEnrollment();
    }
    return enrollment;
  }

  private async requireCompletionClaim(
    token: string,
    requestedRole: InstallerEnrollmentBundleRole,
    nodeId: string,
    now: Date,
  ) {
    const enrollment = await this.requireRedeemed(token, requestedRole, now);
    const current = await this.prisma.installerEnrollment.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, nodeId: true, completedAt: true },
    });
    if (!current?.completedAt || current.nodeId !== nodeId) throw invalidEnrollment();
    return enrollment;
  }

  private async releaseCompletionClaim(
    token: string,
    requestedRole: InstallerEnrollmentBundleRole,
    nodeId: string,
  ) {
    await this.prisma.installerEnrollment.updateMany({
      where: {
        tokenHash: hashToken(token),
        role: toPrismaRole(requestedRole),
        nodeId,
        completedAt: { not: null },
      },
      data: { completedAt: null, nodeId: null },
    });
  }

  private async requireEnrollmentOperation(
    enrollmentId: string,
    operationId: string,
    expectedType: string,
  ) {
    const operation = await this.operations.getOperationById(operationId);
    if (
      !operation ||
      operation.resourceType !== "InstallerEnrollment" ||
      operation.resourceId !== enrollmentId ||
      operation.type !== expectedType
    ) {
      throw invalidEnrollment();
    }
    return operation;
  }

  private objectResult(operation: OperationRecord) {
    if (!operation.result || typeof operation.result !== "object" || Array.isArray(operation.result)) {
      throw new ServiceUnavailableException("Enrollment operation returned an invalid result");
    }
    return operation.result as Record<string, unknown>;
  }

  private assertToken(token: string) {
    if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) throw invalidEnrollment();
  }

  private assertNodeId(nodeId: string) {
    if (!/^[a-zA-Z0-9]{20,64}$/.test(nodeId)) throw invalidEnrollment();
  }

  private assertPublicKey(publicKey: string) {
    try {
      const key = createPublicKey(publicKey);
      if (key.asymmetricKeyType !== "rsa") throw new Error("RSA key required");
    } catch {
      throw invalidEnrollment();
    }
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
