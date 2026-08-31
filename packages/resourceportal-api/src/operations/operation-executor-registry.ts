import type { OperationExecutor } from "./operation-executor";
import type { OperationType } from "./operation.types";

export class OperationExecutorRegistry {
  private readonly executors = new Map<OperationType, OperationExecutor>();

  constructor(executors: OperationExecutor[]) {
    for (const executor of executors) {
      for (const type of executor.types) {
        if (this.executors.has(type)) {
          throw new Error(`DuplicateOperationExecutor: ${type}`);
        }
        this.executors.set(type, executor);
      }
    }
  }

  resolve(type: OperationType) {
    const executor = this.executors.get(type);
    if (!executor) {
      throw new Error(`UnsupportedOperationType: ${type}`);
    }
    return executor;
  }
}
