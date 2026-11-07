# ResourcePortal console: incremental issue #399 remediation

This change builds on the already released #400 (v0.2.141), #401 (v0.2.142)
and #402 (v0.2.143) without changing Prisma schemas, backend authorization or
the supported API contract.

## Navigation / screen contracts

- Tenant Networking is task-scoped at `/tenants/:tenantId/networking/{networks,lan,gates,vpn,topology}`.
  The old `/networking` deep link continues to open the Networks workspace.
  Network attachment grants and LAN attachment grants remain distinct. The
  topology is optional and has a searchable relation table for keyboard access.
  An empty matching table does not signify the absence of all private networks.
- Platform Infrastructure uses `/platform/infrastructure/{overview,swarm,capacity,gpus,storage,locations,updates}`.
  The root URL remains an overview, and the previous `storage-backends` deep
  link continues to open the actual storage backend workspace. ResourcePortal
  updates are no longer embedded below unrelated capacity tables.
- Global search uses actual tenant Access/Administration/Identity & SSO routes,
  not obsolete legacy URLs. Search aliases include roles, groups, network
  topology, LAN, RP Gates, Device VPN, GPUs, operations, billing and updates.
  Search responds to both Ctrl+K and Command+K.
- App Group deployment history has local filtering, bounded table pages, a
  current-version marker and disabled rollback on nonsucceeded/current/active
  deployments. Server eligibility and authorization are still authoritative.
  Accepted deploy/rollback requests are never presented as completed. While
  backend deployment status is active, the UI refreshes the history periodically
  for a bounded window, stopping on navigation/unmount.
  
## Operations and tenant isolation

No new resource endpoint or role was created here. Group, deployment and
network data are still fetched from existing tenant-scoped APIs. The Platform
Admin infrastructure page does not fetch private tenant workload configuration.
A missing measurement must not be displayed as a verified healthy state.
Backend returns the authoritative error when a requested operation is ineligible.

## Remaining audit scope, not addressed by this patch

**This is not full #399 DoD**: the independent domain publishability issue
#394, full networking/Gate diagnostics, grouped infrastructure details,
per-app SSO grants from #398, tenant billing and metric semantics, operation
polling beyond App Group deployments, comprehensive responsive/a11y browser
certification and full API/UI matrix still require follow-up work. In
particular, section names and navigation alone are not evidence that those
features are complete. Do not reclose the manually closed #399 or mark it as
fully resolved based on this patch.

## Validation and release

Test changed routes, existing deep links and backend interaction fixtures,
then run full monorepo lint/test/build/installer/CLI/catalog gates, Fast Fix
and protected merge queue. Official release requires exact-main SHA
post-merge CI, verified automatic image rollback, signed manifest and
installer/CLI artifacts. This no-schema-change patch must not bypass
those controls.
