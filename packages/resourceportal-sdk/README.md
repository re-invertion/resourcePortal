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

## Correlation and request IDs

The client can propagate observability identifiers globally or per request:

```ts
const client = new ResourcePortalClient({
  apiUrl: "https://resource-portal.example.com/api",
  token: process.env.RESOURCE_PORTAL_TOKEN,
  correlationId: "workflow-123",
  requestId: "request-123",
});

await client.request("/auth/me", {
  correlationId: "workflow-override",
  requestId: "request-override",
});
```

`RESOURCE_PORTAL_CORRELATION_ID` and `RESOURCE_PORTAL_REQUEST_ID` are also supported as process environment defaults.

## Public resource surface

Existing resources remain backward-compatible:

```ts
client.account.me()
client.tenants.list()
client.tenants.create(body)
client.tenants.authPolicy(tenantId)
client.tenants.updateAuthPolicy(tenantId, body)
client.tenants.invitations(tenantId)
client.tenants.createInvitation(tenantId, body)
client.tenants.resendInvitation(tenantId, invitationId)
client.tenants.deleteInvitation(tenantId, invitationId)
client.invitations.accept(body)
client.identityProviders.list(tenantId)
client.identityProviders.get(tenantId, identityProviderId)
client.identityProviders.create(tenantId, body)
client.identityProviders.update(tenantId, identityProviderId, body)
client.identityProviders.delete(tenantId, identityProviderId)
client.tenants.groups(tenantId)
client.tenants.createGroup(tenantId, body)
client.tenants.updateGroup(tenantId, groupId, body)
client.tenants.deleteGroup(tenantId, groupId)
client.tenants.addGroupMember(tenantId, groupId, body)
client.tenants.removeGroupMember(tenantId, groupId, membershipId)
client.tenants.assignGroupRole(tenantId, groupId, body)
client.tenants.removeGroupRole(tenantId, groupId, roleId)
client.tenants.billingTransactions(tenantId)
client.tenants.usageRecords(tenantId)
client.tenants.topUpBilling(tenantId, body)
client.appGroups.create(tenantId, body)
client.appGroups.previewStack(tenantId, appGroupId)
client.appGroups.discardChanges(tenantId, appGroupId)
client.appGroups.delete(tenantId, appGroupId)
client.apps.create(tenantId, appGroupId, body)
client.variables.create(tenantId, appGroupId, body)
client.configs.create(tenantId, appGroupId, body)
client.secrets.list(tenantId, appGroupId)
client.secrets.create(tenantId, appGroupId, body)
client.secrets.update(tenantId, appGroupId, secretId, body)
client.secrets.delete(tenantId, appGroupId, secretId)
client.secrets.attach(tenantId, appGroupId, singleAppId, body)
client.secrets.detach(tenantId, appGroupId, singleAppId, attachmentId)
client.volumes.create(tenantId, body)
client.domains.create(tenantId, body)
client.customRootDomains.create(tenantId, body)
client.registries.create(tenantId, body)
client.deployments.create(tenantId, appGroupId, body, idempotencyKey)
client.deployments.events(tenantId, appGroupId, deploymentId)
```

The compatibility sync adds the management APIs introduced by later implementation stages:

```ts
client.platformBilling.listPriceLists()
client.platformBilling.getPriceList(priceListId)
client.platformBilling.createPriceList(body)
client.platformBilling.listVouchers()
client.platformBilling.getVoucher(voucherId)
client.platformBilling.createVoucher(body)
client.platformBilling.disableVoucher(voucherId)
client.platformBilling.payment(body)
client.platformBilling.refund(body)
client.platformBilling.correction(body)

client.platformInfrastructure.getSwarmCluster()
client.platformInfrastructure.reconcileSwarmCluster()
client.platformInfrastructure.listRemoteLocations()
client.platformInfrastructure.getRemoteLocation(remoteLocationId)
client.platformInfrastructure.setRemoteLocationMaintenance(remoteLocationId, enabled)

client.storageBackends.list()
client.storageBackends.get(storageBackendId)
client.storageBackends.validate(storageBackendId)
client.storageBackends.setMaintenance(storageBackendId, enabled)

client.operations.list(tenantId)
client.operations.get(tenantId, operationId)
client.operations.events(tenantId, operationId)
client.operations.retry(tenantId, operationId)

client.platformMaintenance.get()
client.platformMaintenance.set({ enabled, reason })

client.oauthApplications.list(tenantId)
client.oauthApplications.get(tenantId, applicationId)
client.oauthApplications.create(tenantId, body)
client.oauthApplications.update(tenantId, applicationId, body)
client.oauthApplications.rotateCredentials(tenantId, applicationId)
client.oauthApplications.delete(tenantId, applicationId)

client.platformOauthApplications.list()
client.platformOauthApplications.get(applicationId)
client.platformOauthApplications.create(body)
client.platformOauthApplications.update(applicationId, body)
client.platformOauthApplications.rotateCredentials(applicationId)
client.platformOauthApplications.delete(applicationId)

client.serviceIdentities.list(tenantId)
client.serviceIdentities.get(tenantId, serviceIdentityId)
client.serviceIdentities.create(tenantId, body)
client.serviceIdentities.update(tenantId, serviceIdentityId, body)
client.serviceIdentities.rotateCredentials(tenantId, serviceIdentityId)
client.serviceIdentities.delete(tenantId, serviceIdentityId)

client.platformServiceIdentities.list()
client.platformServiceIdentities.get(serviceIdentityId)
client.platformServiceIdentities.create(body)
client.platformServiceIdentities.update(serviceIdentityId, body)
client.platformServiceIdentities.rotateCredentials(serviceIdentityId)
client.platformServiceIdentities.delete(serviceIdentityId)

client.platformIdentityProviders.list()
client.platformIdentityProviders.get(identityProviderId)
client.platformIdentityProviders.create(body)
client.platformIdentityProviders.update(identityProviderId, body)
client.platformIdentityProviders.delete(identityProviderId)

client.auditLog.list(tenantId, filters)
client.auditLog.export(tenantId, { ...filters, format: "csv" })
client.metrics.get()
```

Audit list filters support `action`, `actor`, `resourceType`, `resourceId`, `result`, `requestId`, `correlationId`, `from`, `to`, `cursor` and `limit`. Audit export supports the same filters plus `format=json|csv`.

`metrics.get()` and audit export return text exactly as sent by the API. Other methods continue to parse JSON responses automatically.

## Errors

Failed HTTP responses throw `ResourcePortalApiError`. In addition to the original fields:

```ts
error.status
error.payload
```

structured Resource Portal errors expose:

```ts
error.code
error.details
error.requestId
error.correlationId
```

## Scope boundary

The SDK targets the public Resource Portal management API. `/internal/*` endpoints and routes explicitly protected as internal worker APIs are intentionally excluded, including `/users` guarded by `InternalAuthGuard`.
