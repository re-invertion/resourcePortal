export const OPERATION_TYPES = [
  "APP_GROUP_DEPLOY",
  "APP_GROUP_ROLLBACK",
  "VOLUME_CREATE",
  "VOLUME_RESIZE",
  "VOLUME_DELETE",
  "DOMAIN_VERIFY",
  "CUSTOM_ROOT_DOMAIN_VERIFY",
  "DOMAIN_CERTIFICATE_RECONCILE",
] as const;

export type OperationType = (typeof OPERATION_TYPES)[number];

export const OPERATION_STATUSES = [
  "Pending",
  "Running",
  "Succeeded",
  "Failed",
  "RollingBack",
  "RolledBack",
  "RollbackFailed",
] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export type OperationRecord = {
  id: string;
  type: OperationType;
  tenantId: string | null;
  resourceType: string;
  resourceId: string | null;
  status: OperationStatus;
  phase: string | null;
  createdBy: string;
  createdByEmail: string;
  createdByDisplayName: string;
  input: unknown;
  result: unknown;
  idempotencyKey: string | null;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

export type OperationEventRecord = {
  id: string;
  operationId: string;
  timestamp: Date;
  phase: string | null;
  level: string;
  event: string;
  message: string;
  details: unknown;
};

export type CreateOperationInput = {
  type: OperationType;
  tenantId: string | null;
  resourceType: string;
  resourceId?: string | null;
  phase?: string | null;
  createdBy: string;
  createdByEmail: string;
  createdByDisplayName: string;
  input?: unknown;
  idempotencyKey?: string | null;
  maxAttempts?: number;
};

export type AppendOperationEventInput = {
  phase?: string | null;
  level?: "Info" | "Warn" | "Error";
  event: string;
  message: string;
  details?: unknown;
};

export type OperationExecutionResult = {
  resourceId?: string | null;
  result?: unknown;
};

export type OperationErrorShape = {
  code?: string;
  message?: string;
  retryable?: boolean;
};
