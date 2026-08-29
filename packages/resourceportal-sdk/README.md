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
