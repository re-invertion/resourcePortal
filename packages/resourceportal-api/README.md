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
```

Main public resource groups:

```text
/api/auth
/api/tenants
/api/tenants/:tenantId/app-groups
/api/tenants/:tenantId/volumes
/api/tenants/:tenantId/domains
/api/tenants/:tenantId/registries
/api/tenants/:tenantId/audit-log
```

## Auth

`AUTH_MODE=dev` accepts `x-dev-user-id` and is intended only for local development.

`AUTH_MODE=oidc` and `AUTH_MODE=zitadel` accept bearer JWTs and session cookies issued through the OIDC login flow.

## Deployment Flow

1. Create tenant.
2. Create app group.
3. Add single apps, variables, configs, endpoints, volumes, domains, and registries.
4. Call app group deploy endpoint.
5. Worker claims the deployment and applies Docker Swarm resources.
6. API exposes deployment status and events.

## Storage

New volumes are created under `RESOURCE_STORAGE_ROOT`, defaulting to:

```text
/rp/volumes
```

The stored volume path is mounted into Docker local bind volumes by the worker.
