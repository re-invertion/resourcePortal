# Issue #398 — ResourcePortal authorization boundary for application-only identities

This is a schema-neutral **security prerequisite**, not the App User feature.

An active tenant membership is not proof of permission to inspect ResourcePortal.
Before this patch, GET /api/tenants returned tenant metadata, billing, authentication
policy and the membership roster for **every active membership**. Additionally,
tenant-scoped endpoints without explicit permission decorators accepted a membership
whose effective RolePermission set was empty.

## Enforced behavior

- Tenant inventory is limited to active members who actually have
  tenant.read or * in a direct role's RolePermission bindings or a
  role inherited through an active tenant group; legacy Role.permissions
  array content is not authoritative.
- Tenant-scoped HTTP routes with an authenticated user and an active but
  zero-effective-permission membership return 403 even if an older route
  does not declare a permission decorator. An empty membership is never an
  alternative to tenant.read.
- Normal built-in RP tenant roles include tenant.read, and Owner's *
  continues to work. Members with a nonempty effective permission set
  remain subject to each endpoint's existing RequirePermissions check.
- Tenant-level RBAC is independent of client-specific ZITADEL/OIDC access.
  This change does **not** enroll App Consumers, create client grants, issue
  application entitlements or claim any per-client authorization.

## Follow-on work required before opening App User enrollment

1. Verified and auditable default-deny bindings of
   (tenant, immutable ZITADEL subject, exact OAuthApplication.clientId).
2. An isolated, signed, interruptOnError ZITADEL authorization gate that
   demonstrably receives a trustworthy client identifier for **both**
   authorization-code/PKCE issuance and refresh. A role on a shared ZITADEL
   project alone does not isolate OAuth applications.
3. Invitations and identity lifecycle with zero RP permissions, secure
   reconciliation, suspend/revoke handling and cross-tenant negative cases.
4. End-to-end verification against the pinned real HTTPS ZITADEL issuer with
   two users, two OAuth clients and two tenants, including revoked refresh
   tokens, backend loss and previously issued JWT expiry.
5. A verified database-restore rollback policy before any Prisma/schema
   migration can be released. The existing fast-fix pipeline deliberately
   refuses schema-changing image-only rollback.

Never advertise these prerequisites as implemented App User SSO access.
