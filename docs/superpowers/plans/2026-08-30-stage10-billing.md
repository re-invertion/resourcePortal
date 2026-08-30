# Stage 10 Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Stage 10 prepaid pay-as-you-go billing with immutable pricing, minute usage charging, vouchers, platform adjustments, tenant reads and cost-increase preflight.

**Architecture:** Add a focused NestJS `billing` module backed by Prisma. Keep legacy tenant top-up compatibility while routing all new billing operations through transaction-safe helpers. Run minute usage reconciliation from the existing deployment worker process so no additional deployment topology is required.

**Tech Stack:** NestJS 11, Prisma 6/PostgreSQL, `Prisma.Decimal`, Vitest, existing ResourcePortal auth/audit/runtime services.

**Spec:** `docs/superpowers/specs/2026-08-30-stage10-billing-design.md`

## Global Constraints

- All monetary/rate arithmetic uses `Prisma.Decimal`.
- Usage period is exactly one closed UTC minute.
- Price-list `effectiveFrom` must be aligned to a full UTC minute.
- Compute must not create new debt; storage may create debt.
- Voucher plaintext is returned once and never persisted or audited.
- Billing must not mutate AppGroup/SingleApp runtime state.
- Cost-increasing operations require an active price list; cost-reducing operations do not.

---

### Task 1: Billing math and persistent model

**Files:**
- Create: `packages/resourceportal-api/src/billing/billing-math.ts`
- Test: `packages/resourceportal-api/src/billing/stage10-billing-math.spec.ts`
- Modify: `packages/resourceportal-api/prisma/schema.prisma`
- Create: `packages/resourceportal-api/prisma/migrations/20260830221000_stage10_billing/migration.sql`

**Produces:** active-price selection, minute-cost helpers, credits-to-PLN conversion, immutable PriceList/Voucher/extended UsageRecord schema.

- [ ] Write failing tests for full-minute validation, effective price selection, exact minute costs, compute clamp and PLN derivation.
- [ ] Run CI and confirm the test fails because Stage 10 billing math does not exist.
- [ ] Implement decimal-only helpers and Prisma schema/migration.
- [ ] Run CI and confirm tests/build pass.

### Task 2: Billing service and APIs

**Files:**
- Create: `packages/resourceportal-api/src/billing/billing.service.ts`
- Create: `packages/resourceportal-api/src/billing/billing.controller.ts`
- Create: `packages/resourceportal-api/src/billing/platform-billing.controller.ts`
- Create: `packages/resourceportal-api/src/billing/billing.module.ts`
- Create: `packages/resourceportal-api/src/billing/dto/*.ts`
- Create: `packages/resourceportal-api/src/billing/billing.service.spec.ts`
- Modify: `packages/resourceportal-api/src/app.module.ts`
- Modify: `packages/resourceportal-api/src/tenants/tenants.service.ts`
- Modify: `packages/resourceportal-api/src/tenants/tenants.view.ts`

**Produces:** tenant account/history/usage/summary/voucher endpoints and platform price-list/voucher/payment/refund/correction endpoints; legacy TopUp remains compatible.

- [ ] Write failing behavior tests for price-list creation, voucher hashing/redeem, payment/refund/correction and tenant-scoped reads.
- [ ] Implement transaction-safe balance mutation with before/after ledger snapshots and audit entries.
- [ ] Implement cursor/filter reads and derived PLN fields.
- [ ] Run billing tests.

### Task 3: Usage collector and worker

**Files:**
- Create: `packages/resourceportal-api/src/billing/billing-worker.service.ts`
- Create: `packages/resourceportal-api/src/billing/billing-worker.service.spec.ts`
- Modify: `packages/resourceportal-api/src/internal/deployment-worker.runner.ts`
- Modify: `packages/resourceportal-api/src/billing/billing.module.ts`

**Produces:** one-minute compute/storage collection, idempotent UsageRecords, compute no-debt clamp, storage debt, bounded backfill, worker scheduling.

- [ ] Write failing tests for billed replicas, stopped resources, storage configured size, suspended storage, duplicate periods and backfill bounds.
- [ ] Implement closed-minute reconciliation and atomic charge writes.
- [ ] Integrate a once-per-minute billing tick into the existing worker process.
- [ ] Run worker tests.

### Task 4: Cost-increase preflight

**Files:**
- Create: `packages/resourceportal-api/src/billing/billing-preflight.service.ts`
- Create: `packages/resourceportal-api/src/billing/billing-preflight.service.spec.ts`
- Modify: `packages/resourceportal-api/src/app-groups/app-groups.module.ts`
- Modify: `packages/resourceportal-api/src/app-groups/app-groups.service.ts`
- Modify: `packages/resourceportal-api/src/volumes/volumes.module.ts`
- Modify: `packages/resourceportal-api/src/volumes/volumes.service.ts`

**Produces:** `BillingPriceListUnavailable` gate on create/start/increase paths while stops/decreases remain available.

- [ ] Write failing tests for available/unavailable price lists and increase/decrease detection.
- [ ] Inject the preflight service into AppGroups/Volumes.
- [ ] Gate create/start/grow and runtime-shape increases only.
- [ ] Run affected AppGroups/Volumes tests.

### Task 5: Verification and documentation

**Files:**
- Modify: ResourcePortal Wiki `Billing`
- Modify: ResourcePortal Wiki `Implementation Stages`

- [ ] Run complete CI: dependency audit, Prisma generate, lint, tests and build.
- [ ] Review PR diff against every Stage 10 acceptance item.
- [ ] Merge only after required checks succeed.
- [ ] Update Wiki from merged implementation and record PR, verified head, merge commit and CI evidence.
