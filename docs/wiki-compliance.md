## Resource Portal Wiki Compliance

This document tracks implementation coverage against the Resource Portal wiki documentation.

Checked wiki documents:

- Resource Portal
- Data Models & Relations
- Resource Portal Identity
- Authentication & Federation
- Groups & Directory Access
- Applications & Service Identities
- Tenant
- Tenant Membership / RBAC
- Tenant Invitation
- App Group
- SingleApp
- Deployment Engine
- Volume
- Domain
- Registry
- Billing
- Quota
- Secret

## Implemented And Broadly Aligned

- Tenant ownership, global `User`, tenant membership, direct role-based RBAC, tenant isolation checks.
- Tenant create flow with owner membership, billing account, and audit entry.
- Tenant auth policy model/API, tenant invitations with hashed one-time tokens, tenant groups, group role assignment, and group-based effective permissions.
- Optional tenant quota with hard checks for SingleApps and Volumes.
- AppGroup as one Docker Swarm stack, with `runtimeState`, `health`, `driftStatus`, deployment history, events, and draft revision.
- AppGroup draft operations, including stack preview, discard changes, soft delete, effective runtime state, and runtime blockers.
- SingleApp as one Swarm service with image, resources, replicas, environment, healthcheck, runtime operations, restart/update policy, HTTP endpoints, effective runtime state, effective replicas, and runtime blockers.
- Volume as tenant-owned filesystem storage under `RESOURCE_STORAGE_ROOT/{tenantId}/{volumeId}`, with attachment constraints and no host bind mounts from user input.
- Domain and CustomRootDomain resources, including managed/custom hostnames, DNS/TLS state fields, endpoint assignment, and delete protection.
- Registry resources with TLS/auth modes, encrypted credential metadata, validation, and delete protection when used.
- Deployment Engine with async jobs, idempotency key support, worker lease/heartbeat, deployment events, generated stack YAML, Swarm apply, rollout checks, and automatic rollback paths.
- Billing account, transactions, usage records, top-up operation, and audit for top-up.
- Audit log model and read endpoint.
- API observability: request ids, structured HTTP logs, structured worker logs, liveness/readiness endpoints, and Prometheus-style metrics.
- Swagger, SDK, and CLI for the implemented public API surface.

## Known Gaps Against Wiki

- External directory group mapping is not implemented yet.
- Tenant invitations exist, but the legacy direct membership create endpoint still exists for manual/admin flows.
- Tenant-scoped `IdentityProvider`, platform `IdentityProvider`, Home Realm Discovery, SSO-only tenant policy, and tenant IdP API are not implemented.
- `OAuthApplication` and `ServiceIdentity` models/APIs are not implemented. Machine-to-machine auth currently uses internal worker token and normal OIDC/JWT validation, not the documented Resource Portal identity model.
- AppGroup discard restores the AppGroup and SingleApp runtime draft from the last succeeded deployment snapshot. It does not yet fully restore every related variable/config/secret attachment to historical content.
- AppGroup-owned `Secret` exists in Prisma, but public API currently manages `SingleAppSecret` through runtime config. This does not match the documented AppGroup Secret plus `SecretAttachment` model.
- Secret encrypted payload is stored in the database through `SingleAppSecret.valueCiphertext`, not as encrypted envelope files under `/rp/secrets/{tenantId}/{appGroupId}/{secretName}`.
- Domain DNS and CustomRootDomain validation are currently simplified and do not perform real DNS checks.
- Managed DNS automation and TLS/certificate lifecycle are modeled but not fully integrated with DNS/ACME automation.
- Billing does not yet implement vouchers, recurring usage aggregation/charging workers, low-balance notifications, or automatic `BillingSuspended` runtime blocker enforcement.
- Usage records can be listed, but automatic compute/storage usage accounting is not implemented.
- Deployment reconciliation after worker crash is partial. The worker has leases and idempotent operations, but does not fully reconstruct progress from Docker Swarm before continuing every possible interrupted phase.
- Drift detection is represented by `driftStatus`, but full Swarm reconciliation/drift scanner is not implemented.
- Resolved image digest is not stored in deployment history.
- Generated stack preview is exposed; rendered YAML export is not exposed as a dedicated public API operation yet.
- Platform infrastructure models such as Remote Location, HA Cluster, Swarm Cluster, Swarm Node, Storage Backend, and Placement Engine are intentionally not implemented yet.

## Current Assessment

The backend implements the core Resource Portal control-plane MVP for tenants, workloads, storage, domains, registries, deployments, auth, audit, SDK, CLI, and observability.

It is not yet a complete implementation of the full wiki model. The largest missing areas are Resource Portal Identity beyond basic OIDC/ZITADEL login, service-identity models, AppGroup-level secrets, billing automation, and full deployment reconciliation/drift detection.
