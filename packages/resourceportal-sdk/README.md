Resource Portal SDK is a TypeScript client for the public Resource Portal HTTP API.

## Usage

```ts
import { ResourcePortalClient } from "@resource-portal/sdk";

const client = new ResourcePortalClient({
  apiUrl: "https://resource-portal.example.com/api",
  token: process.env.RESOURCE_PORTAL_TOKEN,
});

const tenants = await client.tenants.list();
```

For local development with `AUTH_MODE=dev`:

```ts
const client = new ResourcePortalClient({
  apiUrl: "http://localhost:3000/api",
  devUserId: "USER_UUID",
});
```

## Main Resources

```ts
client.account.me()
client.tenants.list()
client.tenants.create(body)
client.tenants.billingTransactions(tenantId)
client.tenants.usageRecords(tenantId)
client.tenants.topUpBilling(tenantId, body)
client.appGroups.create(tenantId, body)
client.apps.create(tenantId, appGroupId, body)
client.variables.create(tenantId, appGroupId, body)
client.configs.create(tenantId, appGroupId, body)
client.volumes.create(tenantId, body)
client.domains.create(tenantId, body)
client.customRootDomains.create(tenantId, body)
client.registries.create(tenantId, body)
client.deployments.create(tenantId, appGroupId, body, idempotencyKey)
client.deployments.events(tenantId, appGroupId, deploymentId)
client.auditLog.list(tenantId)
```

## Errors

Failed HTTP responses throw `ResourcePortalApiError` with:

```ts
error.status
error.payload
```
