import { Injectable } from "@nestjs/common";
import { UserStatus } from "@prisma/client";
import type { AuthenticatedUser } from "../../auth/types";
import { DomainsService } from "../../domains/domains.service";
import type { OperationExecutor } from "../operation-executor";
import type {
  OperationRecord,
  OperationType,
} from "../operation.types";

@Injectable()
export class DomainOperationExecutor implements OperationExecutor {
  readonly types = [
    "DOMAIN_VERIFY",
    "CUSTOM_ROOT_DOMAIN_VERIFY",
  ] as const satisfies readonly OperationType[];

  constructor(private readonly domains: DomainsService) {}

  async execute(operation: OperationRecord) {
    const tenantId = this.requireTenantId(operation);
    const resourceId = this.requireResourceId(operation);
    const actor = this.actor(operation);

    switch (operation.type) {
      case "DOMAIN_VERIFY": {
        const result = await this.domains.validateDomain(
          tenantId,
          resourceId,
          actor,
        );
        return { resourceId, result };
      }
      case "CUSTOM_ROOT_DOMAIN_VERIFY": {
        const result = await this.domains.validateCustomRootDomain(
          tenantId,
          resourceId,
          actor,
        );
        return { resourceId, result };
      }
      default:
        throw new Error(`UnsupportedOperationType: ${operation.type}`);
    }
  }

  private actor(operation: OperationRecord): AuthenticatedUser {
    return {
      id: operation.createdBy,
      email: operation.createdByEmail,
      displayName: operation.createdByDisplayName,
      status: UserStatus.Active,
    };
  }

  private requireTenantId(operation: OperationRecord) {
    if (!operation.tenantId) {
      throw new Error("OperationTenantRequired");
    }
    return operation.tenantId;
  }

  private requireResourceId(operation: OperationRecord) {
    if (!operation.resourceId) {
      throw new Error("OperationResourceRequired");
    }
    return operation.resourceId;
  }
}
