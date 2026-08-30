# Stage 10 Billing Design

> Source of truth: ResourcePortal Wiki / Billing, reviewed 2026-08-30.

## Goal

Implement the Stage 10 prepaid pay-as-you-go billing subsystem without changing tenant runtime state as a billing side effect.

## Core invariants

- `BillingAccount.balance` is the source of truth. `balance > 0` means Active; `balance <= 0` means BillingSuspended. `lowBalance` is `balance > 0 && balance <= informationThreshold`.
- Arithmetic uses `Prisma.Decimal`; no JavaScript floating-point arithmetic for money or rates.
- Global immutable `PriceListVersion` rows become active at `effectiveFrom`, aligned to a full UTC minute. Starting rates are CPU 0.50 credit/vCPU/hour, RAM 0.25 credit/GB/hour, storage 0.025 credit/GB/hour and GPU 60.00 credits/GPU/hour.
- Display conversion is fixed at `1 credit = 0.01 PLN` and is derived, never a second balance.
- Missing active price list blocks only cost-increasing operations with `BillingPriceListUnavailable`; cost-reducing operations remain allowed.
- Usage is billed for closed one-minute periods. Usage records are immutable and uniquely identify resource plus period to make the worker idempotent.
- Compute billed replicas are `min(actualReplicas, effectiveReplicas)`. Stopped or billing-blocked runtime has zero effective replicas. Compute charge is `min(theoreticalCost, max(balance, 0))` and does not create new debt.
- Storage uses configured `Volume.sizeBytes`, is charged in full even while BillingSuspended, and may move balance below zero.
- Every balance mutation atomically writes an append-only `BillingTransaction` with before/after balances.
- Supported transaction types: legacy `TopUp`, `VoucherRedeem`, `Payment`, `UsageCharge`, `Refund`, `Correction`.
- Voucher plaintext is cryptographically random, returned once, and never stored. Database stores only `codeHash`. Redeem is exactly-once under concurrency; expired, disabled and already-redeemed vouchers are rejected.
- Platform price-list, voucher-management and adjustment APIs require `PlatformAdminGuard`; tenant reads/redeem remain tenant-scoped with billing permissions.
- Billing writes emit audit actions without secrets. Worker charge audits use system actor metadata.
- Billing does not directly change AppGroup or SingleApp runtime state. Existing runtime blocker derivation uses the billing balance.

## Public API

Tenant API keeps existing billing account, transaction and usage endpoints and adds filtered/paginated reads, usage summary and voucher redemption. Monetary responses expose credits and derived PLN.

Platform API adds immutable price-list creation/list/get, voucher create/disable/list/get, payment, refund and correction operations.

## Worker

A minute worker processes the previous closed minute and backfills a bounded number of missed periods. It resolves the price list effective at each period start, collects compute and storage usage, records immutable usage, and applies charges transactionally. Reprocessing a closed period is safe.

## Preflight

Price-list availability is checked before creating a SingleApp, increasing its compute/replicas, starting an AppGroup or SingleApp, creating a Volume, or growing a Volume. Decreases, stops, deletes and other cost-reducing changes stay available when no price list is active.

## Acceptance

Tests cover price-list selection/alignment, derived PLN, compute/stopped/replica rules, storage size and debt behavior, compute no-debt clamp, usage idempotency/backfill, voucher secrecy and single-use concurrency, payment/refund/correction, immutable transaction snapshots, tenant isolation, platform RBAC, no tenant runtime-state mutation, and preflight behavior.
