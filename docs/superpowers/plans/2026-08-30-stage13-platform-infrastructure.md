# Stage 13 Platform Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a platform-admin Docker Swarm infrastructure inventory with cluster health, Remote Location discovery/capacity, maintenance lifecycle and real-Swarm verification.

**Architecture:** Extend the existing Docker CLI integration behind `DOCKER_CONTEXT`. A singleton `SwarmCluster` and 1:1 `RemoteLocation` records are reconciled from Docker Swarm; maintenance delegates to Docker node availability and RP never owns tenant workload placement.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, Docker CLI/Swarm, Jest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-30-stage13-platform-infrastructure-design.md`

## Global Constraints

- One global Docker Swarm cluster only.
- `RemoteLocation = one Docker Swarm node`; no second node domain model.
- Existing `DOCKER_CONTEXT` is the only runtime access path.
- Platform-admin-only management API.
- Docker Swarm retains placement/rescheduling/HA ownership.
- No per-node agent and no generic multi-runtime adapter.
- TDD: production behavior is added only after a failing test demonstrates it.

---

### Task 1: Domain model and pure infrastructure mapping

**Files:**
- Modify: `packages/resourceportal-api/prisma/schema.prisma`
- Create: `packages/resourceportal-api/prisma/migrations/20260830234000_stage13_platform_infrastructure/migration.sql`
- Create: `packages/resourceportal-api/src/platform-infrastructure/swarm-infrastructure.logic.ts`
- Test: `packages/resourceportal-api/src/platform-infrastructure/swarm-infrastructure.logic.spec.ts`

**Interfaces:**
- Produces `deriveRemoteLocationHealth(status, availability)`.
- Produces `deriveSwarmClusterHealth(nodes)`.
- Produces `parseNodeCapabilities(labels)` returning GPU count and normalized network capability strings.

- [ ] **Step 1: Write failing logic tests** for Ready/Active, Ready/Drain, Down, cluster Healthy/Degraded/Unhealthy and deterministic label parsing.
- [ ] **Step 2: Run** `npm test --workspace @resourceportal/api -- swarm-infrastructure.logic.spec.ts --runInBand` and confirm RED because the module does not exist.
- [ ] **Step 3: Add Prisma enums/models and migration** for `SwarmCluster` and `RemoteLocation` with unique `swarmNodeId` and indexes for status/health.
- [ ] **Step 4: Implement the minimal pure mapping functions** to satisfy the tests.
- [ ] **Step 5: Run the focused test again** and confirm GREEN.
- [ ] **Step 6: Run Prisma generate** and commit the task.

### Task 2: Docker Swarm observation and reconciliation

**Files:**
- Create: `packages/resourceportal-api/src/platform-infrastructure/docker-swarm-infrastructure.service.ts`
- Create: `packages/resourceportal-api/src/platform-infrastructure/swarm-infrastructure.service.ts`
- Test: `packages/resourceportal-api/src/platform-infrastructure/swarm-infrastructure.service.spec.ts`
- Modify: `packages/resourceportal-api/src/internal/stack-runtime.service.ts` only if extracting the Docker command runner is required without duplicating behavior.

**Interfaces:**
- `DockerSwarmInfrastructureService.inspectSwarm(): Promise<ObservedSwarmCluster | null>`.
- `DockerSwarmInfrastructureService.listNodes(): Promise<ObservedSwarmNode[] | null>`.
- `DockerSwarmInfrastructureService.setNodeAvailability(nodeId, availability): Promise<boolean>`.
- `SwarmInfrastructureService.reconcile()` returns `{ nodeCount, managerCount, discovered, removed, health }`.

- [ ] **Step 1: Write failing reconciliation tests** proving first discovery creates records, a second reconcile is idempotent, hostname updates do not duplicate records, and a missing node becomes Removed.
- [ ] **Step 2: Run focused tests** and confirm RED because the services do not exist.
- [ ] **Step 3: Implement Docker observation** using `docker info`, `docker node ls` and `docker node inspect`, honoring `DOCKER_CONTEXT` and `DOCKER_RUNTIME_OPERATION_TIMEOUT_MS`.
- [ ] **Step 4: Implement reconcile** with deterministic upsert-by-node-ID semantics and cluster health derivation.
- [ ] **Step 5: Add failure semantics**: an observation failure records `lastError` on an existing cluster when possible and never converts known nodes to Removed from an incomplete snapshot.
- [ ] **Step 6: Run focused tests** and confirm GREEN; commit.

### Task 3: Platform API, maintenance and scheduler

**Files:**
- Create: `packages/resourceportal-api/src/platform-infrastructure/platform-infrastructure.controller.ts`
- Create: `packages/resourceportal-api/src/platform-infrastructure/platform-infrastructure.module.ts`
- Create: `packages/resourceportal-api/src/platform-infrastructure/dto/set-maintenance.dto.ts`
- Create: `packages/resourceportal-api/src/platform-infrastructure/platform-infrastructure.controller.spec.ts`
- Modify: `packages/resourceportal-api/src/app.module.ts`
- Modify: `packages/resourceportal-api/src/config/env.validation.ts`
- Modify: `packages/resourceportal-api/src/config/env.validation.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- `GET /platform/swarm-cluster`.
- `POST /platform/swarm-cluster/reconcile`.
- `GET /platform/remote-locations`.
- `GET /platform/remote-locations/:id`.
- `PATCH /platform/remote-locations/:id/maintenance` body `{ enabled: boolean }`.

- [ ] **Step 1: Write failing controller/access tests** proving all Stage 13 routes carry `PlatformAdminGuard` and maintenance validates a boolean payload.
- [ ] **Step 2: Write failing service maintenance tests**: Docker failure leaves DB unchanged; Docker success persists Drain/Active and maintenance flag.
- [ ] **Step 3: Run focused tests** and confirm RED.
- [ ] **Step 4: Implement controller/module/DTO and maintenance service method**.
- [ ] **Step 5: Add non-overlapping interval scheduler** controlled by `SWARM_INFRASTRUCTURE_RECONCILE_INTERVAL_MS`, default 30000.
- [ ] **Step 6: Extend env validation/tests and `.env.example`**.
- [ ] **Step 7: Run focused tests** and confirm GREEN; commit.

### Task 4: Audit and real Docker Swarm smoke

**Files:**
- Modify: `packages/resourceportal-api/src/platform-infrastructure/swarm-infrastructure.service.ts`
- Create: `packages/resourceportal-api/scripts/smoke-stage13-platform-infrastructure.ts`
- Modify: `scripts/run-real-swarm-smoke.sh`
- Modify: `.github/workflows/swarm-integration.yml` if the runner command is not already covered by the shared smoke script.

**Interfaces:**
- Global audit events use `tenantId = null` and canonical platform/system actor conventions already established in Stage 12.
- Smoke prints `Stage 13 platform infrastructure smoke passed` only after discovery and maintenance restoration both succeed.

- [ ] **Step 1: Write failing audit tests** for discovered/removed and maintenance transitions with secret-safe details.
- [ ] **Step 2: Run focused tests** and confirm RED.
- [ ] **Step 3: Implement audit writes** using the existing `AuditService` conventions.
- [ ] **Step 4: Add the real-Swarm smoke**: reconcile, assert current manager node is discovered with non-zero CPU/memory, switch current node `active -> drain -> active`, reconcile between transitions, and always restore `active` in `finally`.
- [ ] **Step 5: Run full local/static suite where available**: Prisma generate, lint, unit tests and build.
- [ ] **Step 6: Push final head and verify GitHub Actions**: CI, Real Docker Swarm Integration, Live Federation Integration.
- [ ] **Step 7: Fix any regression using RED/GREEN and repeat verification until all required workflows are green.

## Completion gate

Stage 13 is complete only when:

- the platform API exposes a reconciled single-cluster/RemoteLocation inventory;
- Remote Location identity is stable by Docker node ID;
- capacity and health are visible;
- maintenance is safely delegated to Docker `drain/active`;
- incomplete observation cannot incorrectly remove nodes;
- platform-only access and audit behavior are covered;
- the real Swarm smoke proves discovery and maintenance restore;
- CI, Real Docker Swarm Integration and Live Federation Integration are green on the final head.
