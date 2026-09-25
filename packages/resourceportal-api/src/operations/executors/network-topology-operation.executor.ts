import { Injectable } from "@nestjs/common";
import { UserStatus } from "@prisma/client";
import type { AuthenticatedUser } from "../../auth/types";
import { NetworkingService } from "../../networking/networking.service";
import { PrismaService } from "../../prisma/prisma.service";
import type { OperationExecutor } from "../operation-executor";
import type { OperationRecord, OperationType } from "../operation.types";

type TopologyInput = {
  action?: "APP_ATTACH" | "APP_DETACH" | "GATE_ATTACH" | "GATE_DETACH";
  networkId?: string;
  gateId?: string;
  singleAppId?: string;
  attachmentId?: string;
  address?: string;
  expectedRevision?: number;
  snapshot?: unknown;
};

@Injectable()
export class NetworkTopologyOperationExecutor implements OperationExecutor {
  readonly types = [
    "NETWORK_TOPOLOGY_CHANGE",
  ] as const satisfies readonly OperationType[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly networking: NetworkingService,
  ) {}

  async execute(operation: OperationRecord) {
    const tenantId = operation.tenantId;
    if (!tenantId) {
      throw this.error(
        "OperationTenantRequired",
        "Network topology operation requires a tenant",
        false,
      );
    }
    const input = this.input(operation);
    switch (input.action) {
      case "APP_ATTACH":
        return this.attachApplication(operation, tenantId, input);
      case "APP_DETACH":
        return this.detachApplication(operation, tenantId, input);
      case "GATE_ATTACH":
        return this.attachGate(operation, tenantId, input);
      case "GATE_DETACH":
        return this.detachGate(operation, tenantId, input);
      default:
        throw this.error(
          "OperationInputInvalid",
          "Unsupported network topology change action",
          false,
        );
    }
  }

  private async attachApplication(
    operation: OperationRecord,
    tenantId: string,
    input: TopologyInput,
  ) {
    const networkId = this.required(input.networkId, "networkId");
    const singleAppId = this.required(input.singleAppId, "singleAppId");
    const existing = await this.prisma.networkAttachment.findFirst({
      where: {
        networkId,
        singleAppId,
        network: { tenantId },
      },
    });
    if (existing) {
      if (input.address && existing.address !== input.address) {
        throw this.error(
          "NetworkAttachmentConflict",
          "Application is already attached with a different stable address",
          false,
        );
      }
      return {
        resourceId: existing.id,
        result: {
          action: input.action,
          alreadyApplied: true,
          attachment: existing,
          snapshot: input.snapshot ?? null,
          rollback: "transactional",
        },
      };
    }

    const attachment = await this.networking.attachApplication(
      tenantId,
      networkId,
      {
        singleAppId,
        address: input.address,
        expectedRevision: input.expectedRevision,
      },
      this.actor(operation),
    );
    return {
      resourceId: attachment.id,
      result: {
        action: input.action,
        alreadyApplied: false,
        attachment,
        snapshot: input.snapshot ?? null,
        rollback: "transactional",
      },
    };
  }

  private async detachApplication(
    operation: OperationRecord,
    tenantId: string,
    input: TopologyInput,
  ) {
    const networkId = this.required(input.networkId, "networkId");
    const attachmentId = this.required(input.attachmentId, "attachmentId");
    const existing = await this.prisma.networkAttachment.findFirst({
      where: {
        id: attachmentId,
        networkId,
        network: { tenantId },
      },
    });
    if (!existing) {
      return {
        resourceId: attachmentId,
        result: {
          action: input.action,
          alreadyApplied: true,
          deleted: true,
          snapshot: input.snapshot ?? null,
          rollback: "transactional",
        },
      };
    }
    const result = await this.networking.detachApplication(
      tenantId,
      networkId,
      attachmentId,
      this.actor(operation),
      input.expectedRevision,
    );
    return {
      resourceId: attachmentId,
      result: {
        action: input.action,
        alreadyApplied: false,
        ...result,
        snapshot: input.snapshot ?? null,
        rollback: "transactional",
      },
    };
  }

  private async attachGate(
    operation: OperationRecord,
    tenantId: string,
    input: TopologyInput,
  ) {
    const gateId = this.required(input.gateId, "gateId");
    const networkId = this.required(input.networkId, "networkId");
    const existing = await this.prisma.gateNetworkAttachment.findFirst({
      where: { gateId, networkId, gate: { tenantId } },
    });
    if (existing?.enabled) {
      return {
        resourceId: existing.id,
        result: {
          action: input.action,
          alreadyApplied: true,
          attachment: existing,
          reconciliationPending: true,
          snapshot: input.snapshot ?? null,
          rollback: "transactional",
        },
      };
    }
    const attachment = await this.networking.attachGateNetwork(
      tenantId,
      gateId,
      {
        networkId,
        expectedRevision: input.expectedRevision,
      },
      this.actor(operation),
    );
    return {
      resourceId: attachment.id,
      result: {
        action: input.action,
        alreadyApplied: false,
        attachment,
        reconciliationPending: true,
        snapshot: input.snapshot ?? null,
        rollback: "transactional",
      },
    };
  }

  private async detachGate(
    operation: OperationRecord,
    tenantId: string,
    input: TopologyInput,
  ) {
    const gateId = this.required(input.gateId, "gateId");
    const networkId = this.required(input.networkId, "networkId");
    const existing = await this.prisma.gateNetworkAttachment.findFirst({
      where: { gateId, networkId, gate: { tenantId } },
    });
    if (!existing) {
      return {
        resourceId: gateId,
        result: {
          action: input.action,
          alreadyApplied: true,
          deleted: true,
          reconciliationPending: true,
          snapshot: input.snapshot ?? null,
          rollback: "transactional",
        },
      };
    }
    const result = await this.networking.detachGateNetwork(
      tenantId,
      gateId,
      networkId,
      this.actor(operation),
      input.expectedRevision,
    );
    return {
      resourceId: gateId,
      result: {
        action: input.action,
        alreadyApplied: false,
        ...result,
        reconciliationPending: true,
        snapshot: input.snapshot ?? null,
        rollback: "transactional",
      },
    };
  }

  private input(operation: OperationRecord) {
    if (
      typeof operation.input !== "object" ||
      operation.input === null ||
      Array.isArray(operation.input)
    ) {
      throw this.error(
        "OperationInputInvalid",
        "Network topology operation input is invalid",
        false,
      );
    }
    return operation.input as TopologyInput;
  }

  private required(value: string | undefined, key: string) {
    if (!value) {
      throw this.error(
        "OperationInputInvalid",
        `Network topology operation requires ${key}`,
        false,
      );
    }
    return value;
  }

  private actor(operation: OperationRecord): AuthenticatedUser {
    return {
      id: operation.createdBy,
      email: operation.createdByEmail,
      displayName: operation.createdByDisplayName,
      status: UserStatus.Active,
    };
  }

  private error(code: string, message: string, retryable: boolean) {
    return Object.assign(new Error(message), { code, retryable });
  }
}
