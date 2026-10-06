# ResourcePortal Admin MCP

ResourcePortal Admin MCP is a dedicated Model Context Protocol endpoint for **ResourcePortal Platform Admin** operations.

It is deliberately separate from Tenant MCP:

- Admin MCP endpoint: `/api/platform/mcp`
- Tenant MCP endpoint: `/api/tenants/{tenantId}/mcp`
- Admin OAuth protected-resource metadata: `/.well-known/oauth-protected-resource/api/platform/mcp`
- Tenant OAuth protected-resource metadata remains tenant-specific.

## Security model

Admin MCP does not create a second authorization model. It authenticates an interactive ResourcePortal user through the same OIDC/MCP flow and then requires Platform Admin status.

The endpoint rejects service identities and does not accept tenant membership as a substitute for Platform Admin.

Platform Admin is **not** an implicit tenant administrator. Admin MCP therefore does not expose tools that:

- create, modify, deploy, start, stop or delete tenant workloads,
- modify tenant memberships, groups, invitations, roles or tenant settings,
- modify tenant identity providers, tenant OAuth apps or tenant service identities,
- read tenant secrets or tenant credential values,
- call arbitrary tenant API paths,
- execute arbitrary HTTP requests, SQL, filesystem operations or shell commands.

Global tenant and user directories are available only through read-only Platform Admin endpoints. Billing tools may reference a tenant ID because platform billing is itself a Platform Admin capability; that does not grant access to the tenant's resources.

## OAuth and connection

Admin MCP uses the official Streamable HTTP transport with OAuth protected-resource metadata. Clients should connect directly to:

```
https://<resourceportal-host>/api/platform/mcp
```

No manually created tenant OAuth application is required. The ResourcePortal OIDC issuer, scopes and dynamic client registration are discoverable through the published metadata.

Protected tools require an interactive Platform Admin account. Anonymous MCP discovery and `tools/list` remain available so an MCP client can complete account linking.

## Tool design

Admin MCP intentionally uses explicit tools. There is no `resourceportal_admin_api` or generic path passthrough.

Every tool name starts with `resourceportal_admin_`.

Read tools carry MCP annotations indicating read-only/idempotent behavior. Write and destructive tools are annotated accordingly.

All tool calls are audited as `platform.mcp.tool.call`. The audit record includes the tool name, HTTP method, fixed platform API path, status code, request ID and correlation ID. Request bodies are not stored in the Admin MCP audit event, so replacement credentials and operator notes are not copied into MCP audit metadata.

## Coverage matrix

| Area | Admin MCP capability | Platform API mapping | Tenant impact |
| --- | --- | --- | --- |
| Profile / boundaries | profile, capabilities | internal MCP | none |
| Health | API live/ready, worker health | `/api/health/*` | none |
| Metrics | Prometheus exposition | `GET /api/metrics` | none |
| Tenant directory | list tenants | `GET /api/platform/tenants` | read-only |
| User directory | list users | `GET /api/platform/users` | read-only |
| Swarm | inspect cluster, reconcile | `/api/platform/swarm-cluster*` | platform runtime only |
| Remote locations | list/get, maintenance | `/api/platform/remote-locations*` | platform infrastructure only |
| Resource usage | read aggregate usage | `GET /api/platform/resource-usage` | aggregate read |
| Storage backends | list/get, validate, maintenance | `/api/platform/storage-backends*` | platform storage control |
| Observability | diagnostics | `GET /api/platform/observability/diagnostics` | none |
| Platform operations | list/get/events/retry platform operations | `/api/platform/operations*` | only `tenantId = null` |
| Platform audit | list/export platform audit events | `/api/platform/audit-log*` | only `tenantId = null` |
| Platform maintenance | read/set | `/api/platform/maintenance` | global platform state |
| Network egress | read/update | `/api/platform/network-egress` | platform policy |
| DNS | read/update/validate | `/api/platform/dns*` | platform integration |
| SMTP/email | read/update/validate/test | `/api/platform/email*` | platform integration |
| ResourceBot | read/update/validate/prices | `/api/platform/resource-bot*` | platform integration |
| Billing usage | tenant usage series | `GET /api/platform/billing/usage-series` | billing read only |
| Price lists | list/get/create | `/api/platform/billing/price-lists*` | platform billing |
| Vouchers | list/get/create/disable | `/api/platform/billing/vouchers*` | platform billing |
| Balance mutations | payment/refund/correction | `/api/platform/billing/{payments,refunds,corrections}` | billing state only |
| Identity providers | list/get/create/update/delete | `/api/platform/identity-providers*` | platform identity |
| OAuth applications | list/get/create/update/rotate/delete | `/api/platform/oauth-applications*` | platform identity |
| Service identities | list/get/create/update/rotate/delete | `/api/platform/service-identities*` | platform identity |
| Bug Reports | list/filter, priority, resolve/reopen, image | `/api/platform/bug-reports*` | support/triage only |

## Secret handling

Some Admin MCP update/create tools accept replacement secret material because the matching Platform Admin UI/API already supports those operations. Examples include SMTP password, Cloudflare API token/OAuth client secret, ResourceBot API key and external identity-provider client secret.

Rules:

- read tools must not return stored secret values,
- Admin MCP does not add secret values to its own audit record,
- Admin MCP does not invent alternative storage for secrets,
- one-time credentials returned by existing create/rotate APIs retain the same one-time semantics as the normal API/UI,
- no tool can retrieve decrypted tenant secrets.

## Bug Report administration

Admin MCP exposes first-class Bug Report tools:

- list reports, optionally filtered by priority or resolved state,
- update priority,
- resolve with an optional resolution note,
- reopen,
- retrieve the stored screenshot as MCP image content.

This removes the previous need to reach the platform Bug Report endpoints through a tenant-scoped MCP workaround.

## Operational guidance

Use Admin MCP for platform operations only. Use Tenant MCP when the intended action belongs to a tenant and should be evaluated through that tenant's membership/role/group permissions.

If a desired operation is not represented by an explicit Admin MCP tool, treat that as an intentional boundary until the ResourcePortal platform API itself defines an appropriate Platform Admin capability.
