import type {
  OperationExecutionResult,
  OperationRecord,
  OperationType,
} from "./operation.types";

export interface OperationExecutor {
  readonly types: readonly OperationType[];
  execute(operation: OperationRecord): Promise<OperationExecutionResult>;
}
