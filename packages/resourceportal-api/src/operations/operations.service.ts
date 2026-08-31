import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/types";
import type { OperationType } from "./operation.types";
import { OperationsRepository } from "./operations.repository";

export type EnqueueOperationInput = {
  type: OperationType;
  tenantId: string | null;
  resourceType: string;
  resourceId?: string | null;
  actor: AuthenticatedUser;
  input?: unknown;
  idempotencyKey?: string | null;
  maxAttempts?: number;
};

@Injectable()
export class OperationsService {
  constructor(private readonly repository: OperationsRepository) {}

  enqueue(input: EnqueueOperationInput) {
    return this.repository.createOperation({
      type: input.type,
      tenantId: input.tenantId,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      createdBy: input.actor.id,
      createdByEmail: input.actor.email,
      createdByDisplayName: input.actor.displayName,
      input: input.input ?? {},
      idempotencyKey: input.idempotencyKey ?? null,
      maxAttempts: input.maxAttempts,
    });
  }

  list(tenantId: string) {
    return this.repository.listOperations(tenantId);
  }

  async get(tenantId: string, operationId: string) {
    const operation = await this.repository.getOperation(tenantId, operationId);
    if (!operation) {
      throw new NotFoundException("Operation not found");
    }
    return operation;
  }

  async events(tenantId: string, operationId: string) {
    await this.get(tenantId, operationId);
    return this.repository.listEvents(operationId);
  }

  async retry(tenantId: string, operationId: string) {
    const operation = await this.get(tenantId, operationId);
    if (
      operation.status !== "Failed" &&
      operation.status !== "RollbackFailed"
    ) {
      throw new ConflictException("OperationNotRetryable");
    }

    const retried = await this.repository.retryFailedOperation(
      tenantId,
      operationId,
    );
    if (!retried) {
      throw new ConflictException("OperationNotRetryable");
    }

    await this.repository.appendEvent(operationId, {
      event: "ManualRetryRequested",
      message: "Operation was manually re-queued",
      details: { previousStatus: operation.status },
    });
    return retried;
  }
}
