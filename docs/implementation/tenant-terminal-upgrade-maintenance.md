# Tenant shell, MCP parity and upgrade maintenance implementation audit

This is the implementation worklist for the 2026-10-27 requirement; it does not by itself certify release readiness.

## Existing implementation boundaries

- App Group Single App detail route uses `packages/resourceportal-web/src/pages/app-group/{route,app-detail,application-navigation}.tsx`; Terminal tab and xterm.js view were added alongside Logs.
- Authenticated Single App logs use `AppGroupsController` with `singleapp.read` and `appgroup.deployment.read`, `SingleAppLogsService` resolves the service exclusively through tenant-scoped database lookup, and Worker executes bounded Docker service-log retrieval through internal token auth. Shell must never reuse read-only logs permission.
- Worker internal HTTP server in `packages/resourceportal-api/src/worker.runner.ts` has private token authentication. Restricted Docker exec session lifecycle is implemented there and in the Swarm global agent, with tenant-scoped resolution in API, no caller-controlled Docker target, permissions and auditable actor.
- Tenant MCP dispatch is in `packages/resourceportal-api/src/mcp/tenant-mcp-protocol.service.ts`. It already exposes focused Single App management tools and a tenant-relative API compatibility tool. Each new shell action requires a focused tool with identical authorization to HTTP.
- Installer verifies `.migrations.supportedFromVersions` in `scripts/installer/releases.sh`; `PlatformReleaseService` now exposes and preflights this field from the release manifest.
- Platform maintenance currently has manual administrator controls. Upgrade-operation maintenance UI must derive from durable operation/checkpoint state, not an ephemeral browser variable, and remain readable during API/Worker restarts.

## Required acceptance cases

- Shell opens in selected running task, has bidirectional PTY, resize, EOF, exit status, disconnect/timeout and no implicit privileged or host shell.
- Server maps tenant/group/app IDs to Swarm task/container; validates active tenant/role, disallows unapproved exec, enforces session limits and audits actor, target, start/end (no raw sensitive command transcript by default).
- MCP offers bounded command execution with the exact same server-side permission and target checks, and focused tools cover all tenant UI capabilities after explicit parity inventory.
- UI shows a shell tab, connection/reconnect/error states and sensible unsupported image messages.
- Upgrade status returns supported source versions, current source eligibility and reason; unsupported source fails closed before enqueue and installer still enforces the manifest.
- Upgrade maintenance landing works across reloads, service restarts and successful/failed/rolled-back updates; non-update maintenance must not be misreported as upgrade.
- Release requires security/unit/integration/E2E tests, merge queue, signed manifest and published stable version.

## Implemented architecture — validation matrix

| Tenant UI domain | Focused tenant MCP mapping | State / exception |
|---|---|---|
| App Groups, import, deploy, history, rollback | `resourceportal_manage_app_groups` | Existing operations preserved |
| Single Apps, runtime controls, logs, config, attachments, endpoints | `resourceportal_manage_single_apps`, `resourceportal_get_single_app_logs` | Existing operations preserved |
| Container terminal | `resourceportal_manage_single_app_terminal` (`containers`, `start`, `read`, `write`, `resize`, `close`), `resourceportal_exec_single_app_command` | NEW; same HTTP/API RBAC and audited action metadata |
| Variables, secrets, configs | `resourceportal_manage_app_group_resources` | Existing operations preserved |
| Volumes and storage | `resourceportal_manage_volumes` | Existing operations preserved |
| Registries | `resourceportal_manage_registries` | Existing operations preserved |
| Domain/Cloudflare routing | `resourceportal_manage_domains` | Existing operations preserved |
| Networks, topology, Gate and LAN attachments | `resourceportal_manage_networking` | Existing operations preserved |
| Billing, quota, tenant settings, access, roles, memberships, invitations, groups | `resourceportal_manage_access` (`update_branding` added) | Tenant branding now has a focused MCP operation |
| Tenant identity/OIDC, OAuth clients and service credentials | `resourceportal_manage_identity` | Existing operations preserved |
| ResourceBot and AI settings | `resourceportal_manage_resource_bot` | Existing operations preserved |
| Operations and activity | `resourceportal_manage_operations`, `resourceportal_search_and_audit` | Existing operations preserved |
| Tenant MCP authorization/settings | `resourceportal_manage_mcp_settings` (`catalog` added) | The UI tool catalog now has a focused MCP operation |
| Tenant UI REST endpoints without specialized operation | `resourceportal_tenant_api` | RBAC-constrained escape hatch; **not** equivalent to a dedicated tool for every individual UI control |
| Help/documentation | Tenant Help via UI; documentation is not a tenant-mutating API | MCP client can use read APIs, dedicated Help MCP tool not established |

**Limits before claiming release / DoD:** Remote Swarm-node shells are served by private per-node `terminal-agent` global Swarm service on rp-control overlay. The Worker resolves the owning node from authenticated Swarm agent task inventories, pins each short-lived session to that agent, and fails closed on unavailable nodes. CI now includes a real single-node Swarm PTY handshake/resize/one-shot smoke. A multi-node Swarm test is still required to certify cross-node networking and placement end-to-end. If any of these are required by the acceptance criteria, this implementation is not yet complete. `supportedFromVersions` is enforced independently by the installer and the new API preflight. The public update probe discloses no operation input or actor details. The global update screen is shown only while the most recent platform update operation is Pending or Running, and caches a known-in-progress state during API restarts.
