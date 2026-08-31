import { Injectable } from "@nestjs/common";
import type { OperationStatus, OperationType } from "./operation.types";

export type OperationLifecycleEvent = {
  operationId: string;
  type: OperationType;
  tenantId: string | null;
  resourceType: string;
  resourceId: string | null;
  status: OperationStatus;
  phase: string | null;
  event: string;
  details?: unknown;
};

export type OperationLifecycleHandler = (
  event: OperationLifecycleEvent,
) => void | Promise<void>;

@Injectable()
export class OperationEventBus {
  private readonly handlers = new Set<OperationLifecycleHandler>();

  subscribe(handler: OperationLifecycleHandler) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async publish(event: OperationLifecycleEvent) {
    await Promise.allSettled(
      [...this.handlers].map((handler) =>
        Promise.resolve().then(() => handler(event)),
      ),
    );
  }
}
