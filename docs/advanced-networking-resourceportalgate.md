# Advanced Networking and ResourcePortalGate

Status: implemented and locally verified on branch `feat/advanced-networking-resourceportal-gate`; not yet merged, released or deployed.

## Scope

Advanced Networking replaces the legacy privileged App Group networking path with tenant-scoped `Network` resources and `ResourcePortalGate`.

V1 intentionally provides:

- private tenant Networks that may connect applications across multiple App Groups in the same tenant,
- stable per-application addresses on each Network,
- ResourcePortalGate as a routed WireGuard VPN router,
- one Gate attached to multiple tenant Networks,
- LAN → ResourcePortal Network routing,
- static route guidance for LAN routers,
- React Flow topology plus list/table fallback,
- durable topology Operations with optimistic concurrency.

V1 intentionally does **not** provide private DNS/service discovery, L2 extension, proxy ARP, automatic BGP advertisement, or automatic RP → whole-LAN access.

## Data plane

Each ResourcePortal `Network` maps to an encrypted attachable Docker Swarm overlay. Application membership is rendered into the affected App Group deployment, so adding/removing an application edge marks the App Group draft pending and requires deployment.

ResourcePortalGate runs as an RP-side gateway stack and a small LAN-side systemd agent. WireGuard carries routed traffic between the LAN Gate and the selected tenant Networks.

The default access direction is:

`LAN client → LAN router/static route → Gate LAN IP → WireGuard → RP Gate runtime → selected RP Network → application stable IP`

The reverse direction to arbitrary LAN ranges is not granted automatically.

## Addressing and routing

ResourcePortal allocates separate stable-address and overlay CIDRs. A Gate reports its LAN addresses/CIDRs during enrollment/heartbeat.

For a LAN where the Gate is not the default router, configure a static route for each exported RP Network CIDR with the Gate LAN address as next hop. The tenant Networking UI shows the concrete route plan.

The ResourcePortal server advertises a dedicated public Gate endpoint host configured by `RP_CFG_GATE_ENDPOINT_HOST` (default: the public ResourcePortal domain). WireGuard peers use UDP ports `52000-52999`; production firewalls and any upstream NAT/router must forward this UDP range to the ResourcePortal ingress/control-plane host. The installer manages the matching UFW rule on ingress nodes and refreshes it during upgrades.

CIDR overlap between a Gate LAN and an attached RP Network is rejected.

## Gate enrollment and revocation

1. Create a ResourcePortalGate in tenant Networking.
2. Copy the one-time installer command.
3. Run it as root on a Linux host with systemd.
4. The installer installs `curl`, `jq`, WireGuard tooling, iproute2 and iptables, creates a local WireGuard private key, and enrolls once.
5. Enrollment exchanges the one-time token for an agent token. Only SHA-256 of the agent token is stored server-side.
6. The agent heartbeats, reports LAN addresses/CIDRs and receives desired WireGuard routing configuration.
7. Attach the Gate to selected Networks.
8. To revoke, revoke the Gate in ResourcePortal. The RP-side Gate stack and versioned private-key secret are removed; the Gate status becomes `Revoked`.

Enrollment tokens are one-time and expiring. Rotating enrollment invalidates prior unused enrollment material.

## Threat model and boundaries

The implementation is designed around these constraints:

- tenant isolation is enforced by tenant-scoped queries and Network/Gate RBAC;
- cross-tenant application or Gate attachment is rejected;
- Gate private keys are encrypted in ResourcePortal storage and provisioned to Docker as versioned secrets;
- the LAN agent does not receive Docker socket access or control-plane secrets;
- the agent authenticates with a dedicated token rather than a tenant user session;
- Gate v1 does not create an implicit route from RP workloads to all LAN destinations;
- topology mutations use `expectedRevision`; stale clients receive conflict rather than overwriting newer topology;
- multi-resource topology changes are represented as durable `NETWORK_TOPOLOGY_CHANGE` Operations with replay-safe execution;
- Network deletion is staged as `Deleting`; the DB record is removed only after Docker confirms the managed overlay can be removed;
- an overlay still used by a previous deployment remains in `Deleting` and is retried rather than being force-removed.

## Legacy privileged networking migration

The DB migration is additive. Existing `networkPrivileged`, Internal Port Exposures and platform egress rules are not deleted during schema upgrade.

After upgrade:

- new Internal Port Exposures are rejected,
- edits to existing Internal Port Exposures are rejected,
- existing Internal Port Exposures remain listable and deletable,
- new `networkPrivileged=false → true` grants are rejected,
- new legacy App Group private-network egress exceptions are rejected,
- existing egress exceptions remain enforced until explicitly removed,
- privilege can only be revoked after draft and deployed legacy exposures are gone.

Safe migration sequence for a legacy workload:

1. Create tenant Networks and connect applications.
2. Deploy affected App Groups.
3. Create/enroll a Gate if LAN access is required.
4. Attach the Gate to required Networks and configure LAN static routes.
5. Verify connectivity through stable Network addresses.
6. Remove legacy Internal Port Exposures.
7. Deploy the exposure removal.
8. Remove old platform egress exceptions.
9. Revoke legacy privileged networking.

This avoids both unexpected exposure and sudden loss of connectivity during upgrade.

## Rollout and rollback

Recommended rollout:

1. Apply the additive Prisma migration.
2. Deploy API/Worker/Web with legacy creation paths disabled.
3. Verify Network/Gate API, Worker reconciliation and topology UI.
4. Migrate legacy workloads gradually using the sequence above.
5. Keep legacy rows/schema until all deployments have drained the old path.
6. Remove the legacy schema only in a later release after production inventory confirms no remaining consumers.

Rollback before legacy cleanup is straightforward because the migration is additive and existing legacy data is retained. After a workload has intentionally removed/deployed its legacy exposure, rollback does not recreate that exposure automatically.

## Verification completed

Local release gates completed successfully:

- API, SDK, CLI and Web lint,
- API, SDK, CLI and Web production builds,
- full API test suite,
- full Web test suite: 221 tests,
- SDK: 8 tests,
- CLI: 30 tests,
- Prisma schema validation,
- installer v0.2 placement/networking contracts,
- control-plane installer contracts,
- production packaging tests,
- Gate installer bash syntax/regression test,
- React Flow topology tests,
- Network runtime GC/retry tests,
- durable topology Operation tests,
- real ResourcePortalGate dataplane smoke on dedicated E2E host `.102`: encrypted Swarm overlay + routed WireGuard LAN namespace, assigned stable IP reachability, unassigned-IP denial, no automatic RP→LAN route, Gate restart recovery and access closure after Gate removal/revoke.

The reusable smoke runner is `scripts/run-gate-dataplane-smoke.sh`. Production rollout remains a separate explicit action; this branch has not been merged, released or deployed.
