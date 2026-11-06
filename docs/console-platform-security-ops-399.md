# ResourcePortal Platform Security & Operations — issue #399

This schema-neutral patch restores Platform Admin operational usability using
already authenticated and server-scoped APIs; it does not expand RP authority.

## Screen and API contract

| Platform route | API | Server authorization/scope | UI capabilities |
| --- | --- | --- | --- |
| /platform/security | none (navigation) | Platform Admin navigation | Links to actual operational modules |
| /platform/operations | GET /api/platform/operations; GET /api/platform/operations/:id; GET /api/platform/operations/:id/events; POST /api/platform/operations/:id/retry | PlatformAdminGuard; SQL tenantId IS NULL on list/detail. Retry also rechecks eligibility in service | Platform-only list, event chronology, details (no raw input/result), confirmed retry of eligible failed platform operations |
| /platform/audit | GET /api/platform/audit-log?limit=50&...; GET /api/platform/audit-log/export?format=csv&... | PlatformAdminGuard; buildPlatformWhere selects only tenantId=null | Server filters, cursor pagination, browser CSV export with same applied filters |
| /platform/worker | GET /api/platform/observability/diagnostics | PlatformAdminGuard; worker runtime and reconciliation state (no tenant operation payloads) | Per-worker heartbeat freshness, last loop, last errors; per-reconciliation last success/failure, explicit degraded/unavailable state |
| /platform/network-egress | GET /api/platform/network-egress | PlatformAdminGuard and mandatory private-network isolation | Existing read-only enforcement revision/health panel; no disable action |

All operational state comes from server responses and is not fabricated. A
failed read is shown as an error, not empty success. No tenant operations,
audit events or retry paths are exposed: the backend queries tenantId IS
NULL, and the UI also filters on tenantId === null before presentation.
Retry is offered only for backend-eligible failed platform operations,
requires a confirmation dialog, and is still independently validated by the
server. APP_GROUP_DEPLOY and APP_GROUP_ROLLBACK are never user-retried here.
The Platform Admin diagnostics endpoint reports individual worker health,
last heartbeat/loop and reconciliation outcomes, without rendering raw operation,
secret or tenant payloads. A missing/failed response
must never be presented as healthy.

The already-implemented network egress guard remains mandatory: it cannot
be switched off from the UI or through the API. This patch fixes a stale
navigation target that rendered the generic Infrastructure page.

## Validation and release process

Component regressions include tenant isolation in list/detail/audit, retry
confirmation and exact platform-only POST, read error/fail-closed worker
health, CSV export query scope, and the real egress monitor. New paths are
explicit Fast Fix classifiers for platform-admin-ui, operations, security,
observability and egress; the test catalog is updated. This change is based
on the published v0.2.141 main, but must be rebased to the released new
main after #401 before publication; schema-changing #398 remains separate.
It cannot close all of #399 (other UI audit criteria remain open).
