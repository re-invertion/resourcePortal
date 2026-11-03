# Hybrid Capacity: controlled migration of legacy Swarm task labels (#387)

## Why the upgrade does not automatically restart tenant workloads

ResourcePortal versions before the stable `resourceportal.single-app-id` task label may leave older, running AppGroup services unobservable to the authenticated capacity probe. A control-plane upgrade does **not** automatically rewrite them: changing a Swarm `TaskTemplate.ContainerSpec.Labels` value **recreates tasks**, including stateful applications. Keeping Hybrid in Strict fallback until all expected replicas have trusted observations is intentional; never remove the collector's completeness check to get a green status.

New deployments already render the task label from immutable `SingleApp.id` in `DeploymentExecutionService.renderWorkloadLabels`. No service-label-only fix is sufficient.

## Supported operator runbook

Run from an appropriately authorized maintenance environment with current ResourcePortal API build artifacts, PostgreSQL connection credentials and the manager Docker socket. The CLI lives in the API image as `dist/scripts/capacity-legacy-label-migration.js`; it is **not invoked by the RP upgrade path**, scheduled automatically, or exposed to tenants. Use a maintenance window and notify tenants of service-task restarts.

1. With no flags, run `node dist/scripts/capacity-legacy-label-migration.js` to inspect all running AppGroups. No Docker services are changed. A safe JSON preview lists exact Swarm service IDs, tenant/AppGroup/SingleApp IDs, images, replicas, service specification versions and `migrate` / `skip` actions.
2. Select one AppGroup, and generate a fresh per-group plan using `node dist/scripts/capacity-legacy-label-migration.js --group-id <AppGroup-UUID>`. Review all actions, workload state, replica counts and potential interruption with the tenant/operator.
3. From the same authorized environment execute exactly that plan with `node dist/scripts/capacity-legacy-label-migration.js --group-id <AppGroup-UUID> --apply --approve-sha256 <SHA256-FROM-PREVIEW> --audit-file /mnt/resourceportal/platform/capacity-label-migration.jsonl`. The audit path must be an **existing, persistent, writable, operator-only** volume; never use a container's ephemeral filesystem. Store the exact transcript and audit file with the maintenance ticket.
4. The tool updates **one service at a time**, preserving the full Swarm service spec apart from the missing task label. Docker Engine version-based optimistic concurrency rejects concurrent spec changes. It waits for Docker's rollout to complete and for the expected number of **running tasks with the task-template label** before advancing to the next service. If a service pauses, rolls back, is concurrently modified or fails to converge before the deadline, execution stops immediately. Operators must inspect the service and follow the existing workload rollback procedure rather than blindly retrying.
5. Rerun preview after every partial attempt. Already labeled services are `skip` (no rollout); a changed service or deployment invalidates the previous approval digest. Confirm fresh capacity samples for every expected running replica over several worker collection intervals before considering Hybrid available. If any sample is missing, leave Strict fallback enabled and inspect diagnostic evidence.

**No blanket production mutation is authorized by this runbook.** Do not run `--apply` against all groups, and do not silently restart stateful workloads. Health/stateful backup and maintenance precautions remain operator responsibilities. The tool will not modify unmanaged services, service identities it cannot prove against the currently successful rendered deployment, unknown images, ambiguous normalized names, conflicting tenant/AppGroup/SingleApp labels, paused or stale AppGroup deployments, or global-mode services.

## Identity, concurrency and data safety

The migration maps names from the canonical RP database to exact published AppGroup stack artifacts **only when the AppGroup has no pending draft changes**. Pending name edits make draft SingleApp names unreliable as published identities and cause both preview and apply to fail closed. The tool validates the Swarm stack namespace, current deployment version, image and service ID, and rejects conflicting ownership labels. The image, secrets, volumes, networks, resources, placement, replica count, restart and update policies are not re-rendered from a newer tenant draft; the live Docker ServiceSpec is reused byte-for-byte except for the added task-template label. Docker Engine's `?version=` compare-and-swap prevents replacing a newer specification with stale information. During rollout, the tool compares the actual service specification with the expected updated specification, rather than assuming Swarm `Version.Index` increments by exactly one; unrelated concurrent changes stop the migration. Audit entries are append-only with the planned service identity, start/completion/failure events and timestamps.

This migration is a controlled compatibility path, not a substitute for normal deployment and rollback. In particular, a failed stateful rollout may require operator-directed recovery. Do not execute when an AppGroup deployment is in progress. Keep the current installer signed-release, compatibility and automatic control-plane rollback guarantees unchanged (#386).

## Verification gates

- Unit tests validate identity validation, spoofing/conflicting labels, published image checks, no-op behavior, plan SHA binding, and incomplete telemetry fallback.
- Real Docker Swarm regression must observe actual task-template labels on running replicas (not just service metadata).
- The installer regression simulates transient authenticated Admin API 503, permanent authorization 401 and a deadline overrun. Signed release rollback must remain mandatory.
