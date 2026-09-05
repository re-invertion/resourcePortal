Resource Portal API is the NestJS backend for tenants, applications, storage, domains, registries, auth, audit, billing, and deployment orchestration.

## Commands

```bash
npm --workspace @resource-portal/api run build
npm --workspace @resource-portal/api run lint
npm --workspace @resource-portal/api run test
npm --workspace @resource-portal/api run start
npm --workspace @resource-portal/api run prisma:migrate
npm --workspace @resource-portal/api run db:seed
npm --workspace @resource-portal/api run worker:deployments
npm --workspace @resource-portal/api run smoke:deploy
```

## HTTP

Default base path is `/api`.

Swagger UI is available at:

```text
/api/docs
```

Health endpoint:

```text
GET /api/health
GET /api/health/live
GET /api/health/ready
GET /api/metrics
```

`/api/health/live` potwierdza, że proces API działa. `/api/health/ready` sprawdza zależności wymagane do obsługi ruchu, obecnie PostgreSQL. `/api/metrics` zwraca metryki w formacie Prometheus text exposition.

Every HTTP request receives an `x-request-id` response header. If the caller sends `x-request-id`, the API preserves it; otherwise it generates a UUID. API requests and the deployment worker emit structured JSON log events for easier filtering in log aggregation.

Main public resource groups:

```text
/api/auth
/api/tenants
/api/tenants/:tenantId/auth-policy
/api/tenants/:tenantId/identity-providers
/api/tenants/:tenantId/invitations
/api/tenants/:tenantId/groups
/api/tenants/:tenantId/app-groups
/api/tenants/:tenantId/volumes
/api/tenants/:tenantId/domains
/api/tenants/:tenantId/registries
/api/tenants/:tenantId/audit-log
```

## Auth

`AUTH_MODE=dev` accepts `x-dev-user-id` and is intended only for local development.

`AUTH_MODE=oidc` and `AUTH_MODE=zitadel` accept bearer JWTs and session cookies issued through the OIDC login flow.

Tenant auth policy is available at `/api/tenants/:tenantId/auth-policy`. It controls whether platform login and tenant identity providers are allowed or required.

Tenant identity providers are provisioned in the shared Resource Portal ZITADEL organization through `/api/tenants/:tenantId/identity-providers`. OIDC providers require `issuer`, `clientId`, and `clientSecret`; SAML providers require `metadataUrl`. Client secrets are encrypted before storage and never returned by the API. Configure `ZITADEL_ORGANIZATION_ID`, `ZITADEL_MANAGEMENT_URL`, and a dedicated service-account PAT in `ZITADEL_MANAGEMENT_TOKEN` for provisioning. The organization's custom login policy must allow external identity providers (`allowExternalIdp=true`).

Browser login discovery and direct provider selection are available through:

```text
GET /api/auth/providers?tenantId=TENANT_UUID
GET /api/auth/login?tenantId=TENANT_UUID&identityProviderId=PROVIDER_UUID
```

Direct selection adds the ZITADEL organization and identity-provider reserved scopes to the Authorization Code + PKCE request. Tenant auth policy is enforced before redirecting.

Tenant invitations are available at `/api/tenants/:tenantId/invitations`, with acceptance through `/api/invitations/accept`. The create/resend responses include the raw one-time token; stored invitations keep only a SHA-256 token hash.

Tenant groups are available at `/api/tenants/:tenantId/groups`. Group roles contribute to effective permissions in addition to direct membership roles.

AppGroup responses include derived `effectiveRuntimeState`, `runtimeBlockers`, and SingleApp `effectiveReplicas`. AppGroups also expose draft operations:

```text
GET /api/tenants/:tenantId/app-groups/:appGroupId/stack-preview
POST /api/tenants/:tenantId/app-groups/:appGroupId/discard-changes
DELETE /api/tenants/:tenantId/app-groups/:appGroupId
```

## Secrets

AppGroup secrets are managed through
`/api/tenants/:tenantId/app-groups/:appGroupId/secrets`. Text values use UTF-8;
binary values are submitted as Base64. The API never returns plaintext values.
Each secret can be attached to multiple SingleApps in the same AppGroup and is
mounted by Docker Swarm at `/run/secrets/<targetName>` after deployment.

Encrypted envelopes are stored under `${RESOURCE_STORAGE_BASE_PATH}/secrets`, with `RESOURCE_STORAGE_BASE_PATH` defaulting to `/srv/resource-portal/storage`. Every value uses a random AES-256-GCM data key, and the data key
is wrapped with the Resource Portal master encryption key. Updating an attached
value marks the AppGroup draft as pending but does not deploy automatically.

## Deployment Flow

1. Create tenant.
2. Create app group.
3. Add single apps, variables, configs, endpoints, volumes, domains, and registries.
4. Call app group deploy endpoint.
5. Worker claims the deployment and applies Docker Swarm resources.
6. API exposes deployment status and events.

## Storage

The v1 persistent-storage backend is `LocalFilesystem`. The storage host exposes an XFS or ext4 filesystem with project quotas enabled. The canonical physical root is configurable through `RESOURCE_STORAGE_BASE_PATH` and defaults to:

```text
/srv/resource-portal/storage
```

The physical namespaces are isolated:

```text
/srv/resource-portal/storage/volumes/{tenantId}/{volumeId}
/srv/resource-portal/storage/secrets/{tenantId}/{appGroupId}/{secretName}
/srv/resource-portal/storage/platform
```

Every Volume has a durable numeric `storageProjectId`. `Volume.sizeBytes` is enforced as a filesystem project-quota hard limit and the worker verifies the effective limit after create and resize.

Docker Swarm workloads do not create per-Volume Docker NFS volumes. Eligible nodes have the canonical runtime root:

```text
/mnt/resourceportal/volumes
```

A Volume attachment renders as a bind mount from `/mnt/resourceportal/volumes/{tenantId}/{volumeId}` and constrains the service to nodes with `resourceportal.storage.volumes=true`. On the storage host the runtime root may be a local bind mount; additional nodes may receive the same namespace through NFSv4/NFS-Ganesha prepared by host/installer configuration.

The workload-facing NFS namespace exposes tenant Volume data only. The encrypted `secrets` namespace and internal `platform` namespace must not be exposed to tenant workloads. AppGroup Secret plaintext continues to enter containers only through Docker Swarm Secrets.
