import { Injectable } from "@nestjs/common";
import {
  computeRetryDelayMs,
  isRetryableOperationError,
  operationErrorCode,
  operationErrorMessage,
} from "./operation-retry";
import { OperationExecutorRegistry } from "./operation-executor-registry";
import { OperationsRepository } from "./operations.repository";

@Injectable()
export class OperationsWorkerService {
  constructor(
    private readonly repository: OperationsRepository,
    private readonly registry: OperationExecutorRegistry,
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

        await this.repository.appendEvent(operation.id, {
          phase: operation.phase,
          level: "Warn",
          event: "RetryScheduled",
          message: `Operation retry scheduled after ${retryDelayMs}ms`,
          details: {
            attempt: operation.attempt,
            errorCode,
            errorMessage,
            nextAttemptAt: nextAttemptAt.toISOString(),
          },
        });
        return pending;
      }

      const failed = await this.repository.markFailed(
        operation.id,
        workerId,
        errorCode,
        errorMessage,
      );
      await this.repository.appendEvent(operation.id, {
        phase: operation.phase,
        level: "Error",
        event: "ExecutionFailed",
        message: "Operation execution failed",
        details: {
          attempt: operation.attempt,
          errorCode,
          errorMessage,
        },
      });
      return failed;
    } finally {
      clearInterval(heartbeat);
    }
  }
}
