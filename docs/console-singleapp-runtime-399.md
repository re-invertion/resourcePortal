# ResourcePortal Web Console: SingleApp runtime editor (#399)

This change fills the confirmed gap between the SingleApp create/update DTO and the
Advanced runtime editor. It changes only the schema-neutral Web Console and test
classification; there is no new Prisma migration or server-side authorization bypass.

## Field-to-contract matrix

| UI section | API fields | Read source | Required tenant permission | Apply |
| --- | --- | --- | --- | --- |
| Basics | name, description, image, registryId | GET App Group single-apps | singleapp.update | App Group draft |
| Compute | cpu, memoryBytes, desiredReplicas, runtimeState | GET App Group single-apps | singleapp.update | App Group draft |
| Advanced: container | entrypoint, command, workingDir, user, readOnlyRootFilesystem, stopGracePeriodSeconds | GET App Group single-apps | singleapp.update | App Group draft |
| Advanced: health | healthCheck.command/intervalSeconds/timeoutSeconds/retries/startPeriodSeconds | GET App Group single-apps | singleapp.update | App Group draft |
| Advanced: Swarm policies | restartPolicy.condition/delaySeconds/maxAttempts/windowSeconds; updatePolicy.parallelism/delaySeconds/order | GET App Group single-apps | singleapp.update | App Group draft |
| Environment | environment | GET/PATCH runtime-config | singleapp.update, variable.update, secret.update | App Group draft |
| Variable / secret / config attachments | resource references only (no secret values) | Tenant/App Group scoped endpoints | Relevant resource-specific permissions | App Group draft |

**Every Save request is scoped** to the editor's own fields, rather than rewriting
a whole SingleApp. Patches preserve environment, secrets, resource attachments
and the other editor sections. The Advanced editor retains unrecognized existing
JSON policy keys when saving the supported subset and uses an array of string
arguments for command; it does not split a shell command into arguments.
The health check is intentionally a Docker CMD-SHELL expression because that
is the established server renderer contract: a user must only enter commands
trusted for the image. Disabling it sends an empty object, which makes the
renderer omit the healthcheck on the next deployment. Optional restart window
and attempt fields may be cleared.

The Compute form matches server constraints: CPU 0.01–128, memory at least 128
MiB with integer MiB input, integer replicas 0–100; a tenant quota may be more
restrictive. Invalid values fail locally with no PATCH; the backend remains
authoritative for all permissions, quotas and deployment safety. The
Read-only filesystem toggle does not add or modify mounts; applications
requiring writes must have a supported writable mount.

**Saving is not deploying.** These edits are persisted in an App Group draft;
only a separate Deploy action rolls them out. Start/Stop/Restart remain
immediate runtime operations with distinct controls.

Regression coverage: scoped basic/compute/advanced PATCH payloads, absence
of unrelated/secret values, lossless command argv, JSON policy preservation,
explicit health removal, nonnegative policy constraints, CPU boundary,
and no request after invalid inputs. Changed paths select
reactive-web-state, quota-security and deployment-rollout Fast Fix suites.

This is one subset of #399; other UI/UX audit acceptance criteria remain open
and must not be represented as completed by this patch.
