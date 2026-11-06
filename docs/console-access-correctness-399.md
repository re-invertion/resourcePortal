# Web Console correctness and access administration – issue #399

This document describes the implemented *schema-neutral* console corrections in
the issue #399 patch. The issue is a broad console audit; these corrections are
**not** its complete acceptance criteria, and the issue remains open until its
remaining sections are implemented and verified.

## Scope shipped in this patch

1. **Exact status semantics.** Both the design-system and legacy status
   components use the same explicit enum-to-tone mapper. Health, runtime,
   deployment and operation values are never inferred from substrings of an
   arbitrary explanation. Unknown/compound statuses are neutral rather than
   falsely green. The badge always retains its accessible textual value.
2. **Tenant member access.** Access opens directly on real members/invitations,
   while the legacy `/administration` deep link remains valid. Effective roles
   are displayed separately from direct roles and groups. Authorized operators
   can change direct roles, activate/suspend a membership, remove membership,
   and revoke/regenerate invitations with explicit confirmation.
3. **Tenant groups.** Create/edit/delete groups, add/remove members, and
   assign/remove inherited roles through the existing tenant-scoped API.
   UI controls require matching effective permissions from the authenticated
   user's current active membership; the API guard remains authoritative.
   Backend last-owner, cross-tenant and audit protections remain in force.
4. **App Group activity.** Client filters the tenant-scoped operations list
   against verified App Group, SingleApp and deployment resource IDs obtained
   from scoped endpoints. No missing resource ID implies an association.
   When relationships cannot be fetched, activity fails closed and shows
   an error rather than unrelated tenant operations.
5. **SingleApp configuration.** Existing environment editor is reachable from
   overview and a named configuration subsection; duplicate and empty
   environment variable names are rejected before saving. Saving still creates
   App Group draft changes; deploying is a separate action.
6. **Tenant settings.** Branding, ResourceBot and MCP now render their own
   panels. Branding never renders an unloaded MCP catalog as an actual zero
   count.

## Access control, safety and remaining limitations

- **Viewer is not App User.** Viewer includes ResourcePortal read permissions,
  and must never be assigned to an app-only SSO identity. #398 requires its
  own zero-RP-permission model, per-client OAuth grants, server-side issuance
  and refresh enforcement, revocation and live HTTPS ZITADEL tests. The current
  console patch intentionally does *not* create fake App User functionality.
- UI authorization is only an affordance. Tenant-scoped backend permission
  guards and audit logs still decide every write.
- Client-side activity classification only shows currently verifiable app and
  deployment relations. Historical operations for already-deleted children
  without a persisted group link may not be shown; no unverified guess is made.
- The broader #399 work remains open: runtime form/API parity, platform ops
  and egress diagnostics, networking/infrastructure navigation, domain
  publication work alongside #394, large deployment lists, finance metrics,
  search/a11y and asynchronous workflow refresh.

## Validation

- Scoped unit/component tests cover status enums and badges, an unrelated
  group's operations and unscoped domains, error fail-closed behavior,
  routing for environment and Access, Branding/MCP isolation, role-based
  UI boundaries, role/member changes and group mutations.
- Fast Fix change classification adds mandatory API tenant-access, operations,
  security, application, web console and OAuth/MCP suites. New files are
  explicitly registered so they cannot silently bypass patch tests.
- This patch does not touch the Prisma schema or migrations. Publishing still
  requires the full monorepo lint/test/build, installer/CLI gates, exact-SHA
  CI, merge queue, and real isolated rollback proof per AGENTS.md.
