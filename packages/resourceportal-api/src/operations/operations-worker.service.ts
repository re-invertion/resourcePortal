import { Injectable, Logger } from "@nestjs/common";
import {
  operationCorrelationId,
  structuredLog,
} from "../observability/structured-log";
import { OperationEventBus } from "./operation-event-bus";
import { OperationExecutorRegistry } from "./operation-executor-registry";
import {
  computeRetryDelayMs,
  isRetryableOperationError,
  operationErrorCode,
  operationErrorMessage,
} from "./operation-retry";
import type {
  OperationExecutionResult,
  OperationRecord,
  OperationStatus,
} from "./operation.types";
import { OperationsRepository } from "./operations.repository";

@Injectable()
export class OperationsWorkerService {
  private readonly logger = new Logger(OperationsWorkerService.name);

  constructor(
    private readonly repository: OperationsRepository,
    private readonly registry: OperationExecutorRegistry,
    private readonly eventBus?: OperationEventBus,
  ) {}

  async processNext(workerId: string, leaseSeconds: number) {
    const exhausted = await this.repository.failExhaustedOperations();
    for (const operation of exhausted) {
      const details = {
        attempt: operation.attempt,
        maxAttempts: operation.maxAttempts,
        errorCode: operation.errorCode,
        errorMessage: operation.errorMessage,
      };
      await this.safeAppendEvent(operation.id, {
        phase: operation.phase,
        level: "Error",
        event: "ExecutionAttemptsExhausted",
        message: "Operation execution attempts were exhausted",
        details,
      });
      await this.safePublish(
        operation,
        "Failed",
        "ExecutionAttemptsExhausted",
        details,
      );
      this.logOperation("warn", "worker.operation.attempts_exhausted", operation, {
        workerId: operation.leaseOwner ?? null,
        attempt: operation.attempt,
        maxAttempts: operation.maxAttempts,
        errorCode: operation.errorCode,
      });
    }

    const operation = await this.repository.claimNext(workerId, leaseSeconds);
    if (!operation) {
      return exhausted[0] ?? null;
    }

    this.logOperation("log", "worker.operation.started", operation, {
      workerId,
      attempt: operation.attempt,
      maxAttempts: operation.maxAttempts,
    });

    await this.safeAppendEvent(operation.id, {
      phase: operation.phase,
      event: "ExecutionStarted",
      message: `Operation execution started by worker ${workerId}`,
      details: { attempt: operation.attempt, workerId },
    });
    await this.safePublish(operation, "Running", "ExecutionStarted", {
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
      let execution: OperationExecutionResult;
      try {
        const executor = this.registry.resolve(operation.type);
        execution = await executor.execute(operation);
      } catch (error: unknown) {
        return await this.handleExecutionError(operation, workerId, error);
      }

      // This compare-and-set is the authority boundary. A null result means the
      // lease was lost and another Worker may already own/replay the Operation.
      // Never emit a terminal event from the stale execution in that case.
      const completed = await this.repository.markSucceeded(
        operation.id,
        workerId,
        execution.result ?? null,
        execution.resourceId,
        execution.terminalStatus ?? "Succeeded",
      );
      if (!completed) {
        return null;
      }

      await this.safeAppendEvent(operation.id, {
        phase: operation.phase,
        event: "ExecutionSucceeded",
        message: "Operation execution succeeded",
        details: execution.result ?? null,
      });
      await this.safePublish(
        operation,
        execution.terminalStatus ?? "Succeeded",
        "ExecutionSucceeded",
        execution.result ?? null,
        execution.resourceId ?? operation.resourceId,
      );
      this.logOperation("log", "worker.operation.succeeded", operation, {
        workerId,
        status: execution.terminalStatus ?? "Succeeded",
        attempt: operation.attempt,
        resourceId: execution.resourceId ?? operation.resourceId,
      });

      return completed;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async handleExecutionError(
    operation: OperationRecord,
    workerId: string,
    error: unknown,
  ) {
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
      if (!pending) {
        return null;
      }

      const details = {
        attempt: operation.attempt,
        errorCode,
        errorMessage,
        nextAttemptAt: nextAttemptAt.toISOString(),
      };
      await this.safeAppendEvent(operation.id, {
        phase: operation.phase,
        level: "Warn",
        event: "RetryScheduled",
        message: `Operation retry scheduled after ${retryDelayMs}ms`,
        details,
      });
      await this.safePublish(operation, "Pending", "RetryScheduled", details);
      this.logOperation("warn", "worker.operation.retry_scheduled", operation, {
        workerId,
        attempt: operation.attempt,
        errorCode,
        errorMessage,
        nextAttemptAt: nextAttemptAt.toISOString(),
      });
      return pending;
    }

    const failed = await this.repository.markFailed(
      operation.id,
      workerId,
      errorCode,
      errorMessage,
    );
    if (!failed) {
      return null;
    }

    const details = {
      attempt: operation.attempt,
      errorCode,
      errorMessage,
    };
    await this.safeAppendEvent(operation.id, {
      phase: operation.phase,
      level: "Error",
      event: "ExecutionFailed",
      message: "Operation execution failed",
      details,
    });
    await this.safePublish(operation, "Failed", "ExecutionFailed", details);
    this.logOperation("error", "worker.operation.failed", operation, {
      workerId,
      attempt: operation.attempt,
      errorCode,
      errorMessage,
    });
    return failed;
  }

  private logOperation(
    level: "log" | "warn" | "error",
    event: string,
    operation: OperationRecord,
    fields: Record<string, unknown>,
  ) {
    structuredLog(this.logger, level, "resource-portal-worker", event, {
      operationId: operation.id,
      correlationId: operationCorrelationId(operation.input, operation.id),
      operationType: operation.type,
      tenantId: operation.tenantId,
      resourceType: operation.resourceType,
      resourceId: operation.resourceId,
      ...fields,
    });
  }

  private async safeAppendEvent(
    operationId: string,
    input: Parameters<OperationsRepository["appendEvent"]>[1],
  ) {
    try {
      await this.repository.appendEvent(operationId, input);
    } catch {
      // Operation state is authoritative. Event persistence must never turn a
      // successfully committed side effect into a retry of that side effect.
    }
  }

  private async safePublish(
    operation: OperationRecord,
    status: OperationStatus,
    event: string,
    details?: unknown,
    resourceId = operation.resourceId,
  ) {
    try {
      await this.eventBus?.publish({
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
    } catch {
      // Same rule as persisted events: notifications are observational only.
    }
  }
}
