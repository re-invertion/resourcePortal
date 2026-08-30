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
- Volume lifecycle now refreshes `usedSizeBytes` from the actual storage directory on read/list, treats a not-yet-provisioned path as zero usage, and does not follow symlinks while measuring usage.
- Volume deletion now transitions through `Deleting`, removes the Docker volume and the exact tenant/volume storage directory before deleting the database record, and leaves the record in `Error` when physical cleanup fails. Attached volumes remain protected by `VolumeInUse`.
- Domain and CustomRootDomain resources, including managed/custom hostnames, real DNS TXT ownership verification for custom roots, endpoint assignment, delete protection, protocol-derived TLS requirement, Traefik ACME resolver labels, observed certificate status/issuer/expiry, and active ingress cleanup after route removal.
- Registry resources with TLS/auth modes, encrypted credential metadata, validation, image-host checks, deployment authentication, and delete protection when used.
- Deployment Engine with async jobs, idempotency key support, worker lease/heartbeat, deployment events, generated stack YAML, Swarm apply, rollout checks, and automatic rollback paths.
- Billing account, transactions, usage records, top-up operation, and audit for top-up.
- Audit log model and read endpoint.
- API observability: request ids, structured HTTP logs, structured worker logs, liveness/readiness endpoints, and Prometheus-style metrics.
- Swagger, SDK, and CLI for the implemented public API surface.

## Stage 7 Volume Lifecycle Decision

Stage 7 owns the Resource Portal lifecycle semantics for a Volume: logical capacity (`sizeBytes`), tenant quota validation, no-shrink validation, actual usage reporting (`usedSizeBytes`), attachment protection, Docker volume cleanup, filesystem cleanup, and recoverable error state during deletion.

The current generic filesystem backend is a directory under `RESOURCE_STORAGE_ROOT`. It cannot portably enforce a hard per-directory capacity limit on NFS/ext4/XFS without backend-specific support. For that reason, `PATCH .../resize` updates the logical requested capacity and tenant quota accounting, while physical filesystem quota enforcement and backend-specific resize are explicitly assigned to Stage 14 `StorageBackend`. Stage 7 does not emulate a physical quota with marker files or another non-enforcing mechanism.

Stage 7 verification includes unit coverage for measurement, path-safety, idempotent Docker cleanup, failure preservation, and attachment protection, plus a real-Docker smoke flow that writes data to the storage path, verifies `usedSizeBytes`, creates the bind-backed Docker volume, deletes it through the public Volume API, and verifies both the Docker volume and storage directory are gone.

## Stage 8 Registry Lifecycle Decision

Stage 8 owns tenant-scoped Registry CRUD, TLS and authentication modes, encrypted credential persistence, safe response mapping without plaintext credentials, real `/v2/` validation, validation metadata, image-host matching, `RegistryInUse` delete protection, and deployment authentication handoff.

Registry credentials are decrypted only for validation or deployment use. `UsernamePassword` deployment authentication requires both username and credential. `Token` authentication requires the token credential and uses the configured username when present; when no username is configured, the Docker CLI login uses the stable placeholder username `token`. Credentials are passed through `--password-stdin`, and stack application uses `docker stack deploy --with-registry-auth`.

Stage 8 verification includes the existing Registry service and image-host tests plus a focused regression test for token-based Docker login. The repository's real Docker Swarm workflow continues to exercise the deployment path and `--with-registry-auth`; it does not provision a dedicated authenticated private registry, so this document does not claim a real private-registry pull smoke test.

## Stage 9 Domains, HTTP Endpoints And TLS Decision

Stage 9 keeps Traefik as the owner of ACME issuance, renewal, certificate/private-key storage, and certificate presentation. Resource Portal does not implement a second ACME client and does not persist private certificate keys or ACME account secrets.

`HttpEndpoint.protocolMode` is the source of truth for TLS requirement. `HTTP` disables TLS; `HTTPS`, `HTTP_AND_HTTPS`, and `HTTP_REDIRECT_TO_HTTPS` require TLS. Domain persistence and API responses normalize `tlsEnabled` from the assigned endpoint instead of trusting a contradictory client flag. Detaching a Domain clears stale certificate metadata immediately.

TLS routers render `traefik.http.routers.<router>.tls=true` and, when `TRAEFIK_CERT_RESOLVER` is configured, `traefik.http.routers.<router>.tls.certresolver=<resolver>`. The resolver name is environment-validated. HTTP-only routers never receive TLS or resolver labels.

The deployment worker periodically reconciles certificate metadata. It performs a trusted TLS handshake for each Domain assigned to a TLS-requiring endpoint, validates hostname/SAN coverage and expiry, and stores only safe observed metadata: `certificateStatus`, `certificateIssuer`, and `certificateExpiresAt`. Traefik performs renewal; Resource Portal observes the renewed certificate and refreshes the expiry/status. Failed or not-yet-issued certificates are represented as `Issuing`/`Error` according to prior observed state.

Ingress cleanup is intentionally cleanup-only. The worker may remove obsolete RP-owned Traefik labels from an already deployed Swarm service after Domain detach, endpoint removal, or protocol changes, but it does not publish new or changed draft routes before a normal AppGroup deployment. This preserves the existing draft/deploy boundary while satisfying prompt route removal.

Stage 9 verification includes unit/regression coverage for all four protocol modes, resolver labels, Domain TLS normalization, certificate observation/reconciliation, wildcard hostname coverage, failure isolation, and cleanup namespace safety. The Real Docker Swarm workflow additionally deploys an HTTPS endpoint plus managed Domain, verifies the live service has the expected host/TLS/certresolver labels, detaches the Domain, runs reconciliation, and verifies the router labels are removed while the service label remains. CI intentionally does not contact Let's Encrypt or claim a real public-CA issuance test.

## Known Gaps Against Wiki

- External directory group mapping is not implemented yet.
- Tenant invitations exist, but the legacy direct membership create endpoint still exists for manual/admin flows.
- Tenant-scoped `IdentityProvider`, platform `IdentityProvider`, Home Realm Discovery, SSO-only tenant policy, and tenant IdP API are not implemented.
- `OAuthApplication` and `ServiceIdentity` models/APIs are not implemented. Machine-to-machine auth currently uses internal worker token and normal OIDC/JWT validation, not the documented Resource Portal identity model.
- AppGroup discard restores the AppGroup and SingleApp runtime draft from the last succeeded deployment snapshot. It does not yet fully restore every related variable/config/secret attachment to historical content.
- AppGroup-owned `Secret` exists in Prisma, but public API currently manages `SingleAppSecret` through runtime config. This does not match the documented AppGroup Secret plus `SecretAttachment` model.
- Secret encrypted payload is stored in the database through `SingleAppSecret.valueCiphertext`, not as encrypted envelope files under `/rp/secrets/{tenantId}/{appGroupId}/{secretName}`.
- CustomRootDomain ownership validation performs a real DNS TXT lookup, but general Domain `dnsStatus` validation remains simplified and managed-domain DNS provider automation is not implemented in this repository.
- Billing does not yet implement vouchers, recurring usage aggregation/charging workers, low-balance notifications, or automatic `BillingSuspended` runtime blocker enforcement.
- Usage records can be listed, but automatic compute/storage usage accounting is not implemented.
- Deployment reconciliation after worker crash is partial. The worker has leases and idempotent operations, but does not fully reconstruct progress from Docker Swarm before continuing every possible interrupted phase.
- Drift detection is represented by `driftStatus`, but full Swarm reconciliation/drift scanner is not implemented.
- Resolved image digest is not stored in deployment history.
- Generated stack preview is exposed; rendered YAML export is not exposed as a dedicated public API operation yet.
- Platform infrastructure models such as Remote Location, HA Cluster, Swarm Cluster, Swarm Node, Storage Backend, and Placement Engine are intentionally not implemented yet. `StorageBackend` is also the planned owner of physical per-volume quota enforcement and backend-specific resize semantics referenced by Stage 7.

## Current Assessment

The backend implements the core Resource Portal control-plane MVP for tenants, workloads, storage, domains, registries, deployments, auth, audit, SDK, CLI, and observability.

It is not yet a complete implementation of the full wiki model. The largest missing areas are Resource Portal Identity beyond basic OIDC/ZITADEL login, service-identity models, AppGroup-level secrets, billing automation, and full deployment reconciliation/drift detection.
