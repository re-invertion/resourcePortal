import { Injectable } from "@nestjs/common";
import { OperationEventBus } from "./operation-event-bus";
import { OperationExecutorRegistry } from "./operation-executor-registry";
import {
  computeRetryDelayMs,
  isRetryableOperationError,
  operationErrorCode,
  operationErrorMessage,
} from "./operation-retry";
import type { OperationRecord, OperationStatus } from "./operation.types";
import { OperationsRepository } from "./operations.repository";

@Injectable()
export class OperationsWorkerService {
  constructor(
    private readonly repository: OperationsRepository,
    private readonly registry: OperationExecutorRegistry,
    private readonly eventBus?: OperationEventBus,
  ) {}

  async processNext(workerId: string, leaseSeconds: number) {
    const operation = await this.repository.claimNext(workerId, leaseSeconds);
    if (!operation) {
      return null;
    }

    await this.repository.appendEvent(operation.id, {
      phase: operation.phase,
      event: "ExecutionStarted",
      message: `Operation execution started by worker ${workerId}`,
      details: { attempt: operation.attempt, workerId },
    });
    await this.publish(operation, "Running", "ExecutionStarted", {
      attempt: operation.attempt,
      workerId,
    });

    const heartbeatIntervalMs = Math.max(
      1_000,
      Math.floor((leaseSeconds * 1_000) / 3),
    );
    const heartbeat = setInterval(() => {
      void this.repository
        .heartbeat(operation.id, workerId, leaseSeconds)
        .catch(() => undefined);
    }, heartbeatIntervalMs);

    try {
      const executor = this.registry.resolve(operation.type);
      const execution = await executor.execute(operation);
      const completed = await this.repository.markSucceeded(
        operation.id,
        workerId,
        execution.result ?? null,
        execution.resourceId,
      );

      await this.repository.appendEvent(operation.id, {
        phase: operation.phase,
        event: "ExecutionSucceeded",
        message: "Operation execution succeeded",
        details: execution.result ?? null,
      });
      await this.publish(
        operation,
        "Succeeded",
        "ExecutionSucceeded",
        execution.result ?? null,
        execution.resourceId ?? operation.resourceId,
      );

      return completed;
    } catch (error: unknown) {
      const errorCode = operationErrorCode(error);
      const errorMessage = operationErrorMessage(error);
      const canRetry =
        isRetryableOperationError(error) &&
        operation.attempt < operation.maxAttempts;

      if (canRetry) {
        const retryDelayMs = computeRetryDelayMs(operation.attempt);
        const nextAttemptAt = new Date(Date.now() + retryDelayMs);
        const pending = await this.repository.scheduleRetry(
          operation.id,
          workerId,
          nextAttemptAt,
          errorCode,
          errorMessage,
        );

        const details = {
          attempt: operation.attempt,
          errorCode,
          errorMessage,
          nextAttemptAt: nextAttemptAt.toISOString(),
        };
        await this.repository.appendEvent(operation.id, {
          phase: operation.phase,
          level: "Warn",
          event: "RetryScheduled",
          message: `Operation retry scheduled after ${retryDelayMs}ms`,
          details,
        });
        await this.publish(operation, "Pending", "RetryScheduled", details);
        return pending;
      }

      const failed = await this.repository.markFailed(
        operation.id,
        workerId,
        errorCode,
        errorMessage,
      );
      const details = {
        attempt: operation.attempt,
        errorCode,
        errorMessage,
      };
      await this.repository.appendEvent(operation.id, {
        phase: operation.phase,
        level: "Error",
        event: "ExecutionFailed",
        message: "Operation execution failed",
        details,
      });
      await this.publish(operation, "Failed", "ExecutionFailed", details);
      return failed;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private publish(
    operation: OperationRecord,
    status: OperationStatus,
    event: string,
    details?: unknown,
    resourceId = operation.resourceId,
  ) {
    return this.eventBus?.publish({
      operationId: operation.id,
      type: operation.type,
      tenantId: operation.tenantId,
      resourceType: operation.resourceType,
      resourceId,
      status,
      phase: operation.phase,
      event,
      details,
    });
  }
}
