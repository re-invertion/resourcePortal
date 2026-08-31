# Stage 16 — Operations / Jobs Design

## Goal

Introduce a reusable, DB-backed Operations/Jobs execution layer for long-running infrastructure work without replacing the stable Stage 6 AppGroup deployment engine.

## Architectural decision

Stage 16 uses Variant A: a compatible Operations Core is added alongside the specialized AppGroupDeployment engine.

- New long-running workflows use `Operation` + `OperationEvent`.
- Existing AppGroup deployment remains the rollout implementation of record and is represented in Operations through an adapter/mirror rather than a rewrite.
- Volume and Domain long-running side effects move behind the generic operation worker.
- Docker Swarm remains the only container scheduler.
- Traefik remains responsible for ACME issuance/renewal and private keys.

## Operation model

Operations are persisted in PostgreSQL and accessed by a focused repository using Prisma raw SQL so Stage 16 can be introduced without forcing an invasive rewrite of the existing Prisma domain model.

Required fields:

- `id` UUID
- `type` text
- `tenantId` UUID, nullable only for future platform-global operations
- `resourceType` text
- `resourceId` UUID nullable until a create executor produces a resource
- `status`: `Pending`, `Running`, `Succeeded`, `Failed`, `RollingBack`, `RolledBack`, `RollbackFailed`
- `phase` text nullable
- `createdBy` UUID
- `createdByEmail` text
- `createdByDisplayName` text
- `input` JSONB
- `result` JSONB nullable
- `idempotencyKey` text nullable
- `attempt` integer
- `maxAttempts` integer
- `nextAttemptAt` timestamp
- lease/heartbeat fields
- error fields
- timestamps

Tenant-scoped idempotency uses a partial unique index over `(tenantId, type, idempotencyKey)` when an idempotency key is present.

## Operation events

`OperationEvent` is append-only and records technical execution history. It does not replace Audit Log.

Typical events:

- `OperationCreated`
- `OperationClaimed`
- `ExecutionStarted`
- `ExecutionSucceeded`
- `ExecutionFailed`
- `RetryScheduled`
- `Heartbeat`

## Generic worker

A separate `operation-worker.runner.ts` is introduced for Stage 16. It polls DB-backed Operations and delegates execution to `OperationExecutorRegistry`.

The runner is intentionally separate from `deployment-worker.runner.ts` during this stage. The shared abstraction is the executor/lease/retry contract, while the stable deployment process remains unchanged.

Worker responsibilities:

1. atomically claim an eligible operation;
2. set lease owner/expiry and heartbeat;
3. resolve executor by operation type;
4. execute domain-specific work;
5. persist result/events;
6. retry transient errors with bounded exponential backoff;
7. mark permanent/exhausted failures terminally.

## Retry policy

Default retry policy:

- max attempts: 5
- base delay: 5 seconds
- exponential factor: 2
- maximum delay: 5 minutes

Transient errors include infrastructure availability failures such as `PlatformUnavailable`, selected network/DNS observation failures, and explicit executor-classified transient failures.

`InsufficientCapacity` remains a stable Stage 15 error and may be retried for queued infrastructure work because capacity can change over time.

## Executors in Stage 16

### VOLUME_CREATE

Calls the existing `VolumesService.createVolume` so Stage 14 CephFS reservation, quota enforcement, provisioning and cleanup logic remains single-sourced. On success the created Volume id becomes `Operation.resourceId`.

### VOLUME_RESIZE

Calls the existing `VolumesService.resizeVolume` using the queued desired size.

### VOLUME_DELETE

Calls the existing `VolumesService.deleteVolume`; `VolumeInUse` remains a permanent business failure.

### DOMAIN_VERIFY

Calls existing Domain validation logic and records the resulting Domain state.

### CUSTOM_ROOT_DOMAIN_VERIFY

Calls the existing DNS TXT validation logic. DNS resolver/transport failures are retryable, while a completed negative verification is a successful operation whose business result contains the failed verification state.

### APP_GROUP_DEPLOY / APP_GROUP_ROLLBACK

AppGroupDeployment remains the execution engine. A Stage 16 adapter records an Operation in the same transaction as deployment creation and synchronizes the Operation outcome from AppGroupDeployment state. Stage 16 does not duplicate stack rendering, apply, rollout verification, rollback, capacity admission, lease or recovery code.

## API

Tenant Operations API:

- `GET /tenants/:tenantId/operations`
- `GET /tenants/:tenantId/operations/:operationId`
- `GET /tenants/:tenantId/operations/:operationId/events`
- `POST /tenants/:tenantId/operations/:operationId/retry`

Long-running mutation endpoints return the queued Operation instead of blocking on infrastructure side effects:

- Volume create/resize/delete
- Domain validation
- Custom root domain validation

Existing read endpoints remain unchanged.

## Security

- Existing endpoint permissions remain authoritative for queue submission.
- Operations reads require tenant context and `operation.read` permission.
- Manual retry requires `operation.retry` permission.
- Worker execution uses the creator identity snapshot stored on Operation only to preserve existing audit/update attribution semantics; it does not re-authorize the queued request.

## Events, Audit and domain events

- `OperationEvent`: technical execution trace.
- `AuditLogEntry`: actor/action/result accountability remains in existing domain services.
- lightweight in-process domain event bus: emits operation lifecycle notifications for internal consumers; no Kafka/RabbitMQ introduced.

## Compatibility guarantees

- No rewrite of Stage 6 deployment rollout logic.
- No change to Docker Swarm scheduling ownership.
- No change to Stage 14 CephFS adapter ownership.
- No ACME/private-key ownership change from Traefik.
- Resource lifecycle enums remain separate from Operation lifecycle.
- Existing stable error names such as `VolumeInUse`, `InsufficientCapacity`, and `PlatformUnavailable` are preserved.

## Verification

Stage 16 is complete only after:

- Prisma migration applies on real PostgreSQL;
- unit tests cover repository claiming, idempotency, retry/backoff and registry dispatch;
- controller tests prove long-running endpoints enqueue rather than execute synchronously;
- regression tests prove specialized AppGroupDeployment behavior is unchanged;
- CI succeeds;
- Real Docker Swarm Integration succeeds;
- Live Federation Integration succeeds;
- Wiki is updated from the exact verified and merged head.
