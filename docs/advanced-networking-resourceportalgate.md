# Advanced Networking and ResourcePortalGate

Status: implemented.

## Scope

Advanced Networking provides tenant-scoped `Network` resources, automatic App Group networks and `ResourcePortalGate`.

The current implementation provides:

- private tenant Networks that may connect applications across multiple App Groups in the same tenant,
- stable per-application addresses on each Network,
- ResourcePortalGate as a routed WireGuard VPN router,
- one Gate attached to multiple tenant Networks,
- LAN → ResourcePortal Network routing,
- manual static-route guidance for LAN routers,
- optional automatic export-only eBGP route advertisement from the LAN-side Gate,
- React Flow topology plus list/table fallback,
- durable topology Operations with optimistic concurrency.

It intentionally does **not** provide private DNS/service discovery, L2 extension, proxy ARP, automatic import of LAN routes, or automatic RP → whole-LAN access.

## Data plane

Each ResourcePortal `Network` maps to an encrypted attachable Docker Swarm overlay. Application membership is rendered into the affected App Group deployment, so adding/removing an application edge marks the App Group draft pending and requires deployment.

ResourcePortalGate runs as an RP-side gateway stack and a small LAN-side systemd agent. WireGuard carries routed traffic between the LAN Gate and the selected tenant Networks.

The default access direction is:

`LAN client → LAN router → Gate LAN IP → WireGuard → RP Gate runtime → selected RP Network → application stable IP`

The reverse direction to arbitrary LAN ranges is not granted automatically.

## Addressing and routing

ResourcePortal allocates separate stable-address and overlay CIDRs. A Gate reports its LAN addresses/CIDRs during enrollment/heartbeat.

Each Gate has one route-advertisement mode:

- **Manual** — configure a static route for each exported RP Network CIDR with the Gate LAN address as next hop.
- **BGP** — the Gate runs FRRouting (FRR) and establishes eBGP to the configured LAN router. ResourcePortal automatically derives the exported prefixes from active `GateNetworkAttachment` records.

In BGP mode there is no API field for arbitrary advertised prefixes. The desired `advertisedCidrs` list is server-generated from Networks currently attached to the Gate. Removing a Gate → Network attachment removes that CIDR from desired BGP state.

The generated FRR policy is export-only:

- `RP-GATE-EXPORT` explicitly permits only attached RP Network CIDRs and ends with `deny any`;
- `RP-GATE-IMPORT` denies all received IPv4 prefixes;
- no connected, kernel, static or dynamic routing protocol is redistributed into BGP;
- the configured LAN router address must belong to a LAN CIDR reported by the Gate;
- when provided, the BGP source address must be one of the Gate's reported LAN addresses;
- Gate and router ASNs must be different, so the managed mode is eBGP.

FRR keeps normal BGP network import-check behavior. An RP prefix is therefore advertised only while the corresponding route exists on the Gate host. Because WireGuard `AllowedIPs` installs those RP routes, a tunnel failure naturally withdraws the BGP advertisement.

The ResourcePortal server advertises a dedicated public Gate endpoint host configured by `RP_CFG_GATE_ENDPOINT_HOST` (default: the public ResourcePortal domain). WireGuard peers use UDP ports `52000-52999`; production firewalls and any upstream NAT/router must forward this UDP range to the ResourcePortal ingress/control-plane host. The installer manages the matching UFW rule on ingress nodes and refreshes it during upgrades.

CIDR overlap between a Gate LAN and an attached RP Network is rejected.

## Gate enrollment and revocation

1. Create a ResourcePortalGate in tenant Networking.
2. Copy the one-time installer command.
3. Run it as root on a Linux host with systemd.
4. The installer installs the core Gate dependencies (`curl`, `jq`, WireGuard tooling, iproute2 and iptables), creates a local WireGuard private key, and enrolls once. FRR is installed lazily by the agent only when BGP mode is enabled.
5. Enrollment exchanges the one-time token for an agent token. Only SHA-256 of the agent token is stored server-side.
6. The agent heartbeats, reports LAN addresses/CIDRs and receives desired WireGuard and route-advertisement configuration.
7. Attach the Gate to selected Networks.
8. Optionally switch Route advertisement from Manual to BGP and configure local ASN, router ASN, router IP, optional source IP and hold time.
9. To revoke, revoke the Gate in ResourcePortal. The agent token is rejected, WireGuard is brought down and the agent removes its managed BGP advertisement block. The RP-side Gate stack and versioned private-key secret are removed by normal cleanup.

Enrollment tokens are one-time and expiring. Rotating enrollment invalidates prior unused enrollment material.

## FRR ownership boundary

The Gate agent owns only the configuration block marked:

`! BEGIN RESOURCEPORTAL-GATE` … `! END RESOURCEPORTAL-GATE`

Existing non-BGP FRR configuration outside that block is preserved. If the host already contains an unmanaged `router bgp ...` stanza outside the ResourcePortal block, the agent refuses BGP reconciliation instead of taking over an existing BGP control plane.

This means the automatic mode is intended for a Gate host where ResourcePortal is the owner of the FRR BGP process. It does not silently merge with an independently managed BGP setup.

## Threat model and boundaries

The implementation is designed around these constraints:

- tenant isolation is enforced by tenant-scoped queries and Network/Gate RBAC;
- cross-tenant application or Gate attachment is rejected;
- Gate private keys are encrypted in ResourcePortal storage and provisioned to Docker as versioned secrets;
- the LAN agent does not receive Docker socket access or control-plane secrets;
- the agent authenticates with a dedicated token rather than a tenant user session;
- BGP never imports LAN routes into ResourcePortal;
- only active Gate → Network attachments can become BGP export prefixes;
- revocation disables both the WireGuard tunnel and ResourcePortal-managed BGP advertisements;
- Gate does not create an implicit route from RP workloads to all LAN destinations;
- topology mutations use `expectedRevision`; stale clients receive conflict rather than overwriting newer topology;
- multi-resource topology changes are represented as durable `NETWORK_TOPOLOGY_CHANGE` Operations with replay-safe execution;
- Network deletion is staged as `Deleting`; the DB record is removed only after Docker confirms the managed overlay can be removed;
- an overlay still used by a previous deployment remains in `Deleting` and is retried rather than being force-removed.

## Current network model

Every deployed App Group has its own automatic overlay network, and the topology API exposes that network together with the applications that actually belong to it. Tenant-scoped `Network` resources add explicit cross-App-Group connectivity, while ResourcePortalGate provides routed LAN access only to the Networks selected by the tenant.

The Networking canvas is derived from current ResourcePortal state. It renders automatic App Group membership, explicit application-to-Network attachments and Gate-to-Network attachments; it does not synthesize decorative topology edges or status labels.

The Networking UI exposes the Gate route-advertisement mode and the effective exported prefix list. Prefixes are read-only because `GateNetworkAttachment` remains the source of truth.

Platform private-network egress protection remains a single global policy. When enabled, tenant workloads are blocked from protected private-address ranges outside ResourcePortal-managed Networks. There are no per-App-Group bypass controls.

## Upgrade safety

The BGP migration only adds nullable BGP settings plus defaults for Manual mode and hold time. Existing Gates therefore remain in Manual mode after upgrade and continue to use the previous static-route workflow until an administrator explicitly enables BGP.

The older networking schema cleanup migration still refuses to run while state incompatible with the current networking model is present.

## Verification

The implementation is covered by:

- Prisma schema validation and migration checks,
- backend tests for BGP validation, audit state and agent desired-state projection,
- tests proving advertised CIDRs are derived from Gate Network attachments,
- Gate installer bash syntax/regression tests,
- FRR policy assertions for export allow-list, inbound deny-all and absence of route redistribution,
- Web Console tests for the Manual/BGP configuration flow,
- existing React Flow topology, networking runtime and Gate lifecycle tests.

The reusable dataplane smoke runner remains `scripts/run-gate-dataplane-smoke.sh`. Production rollout is a separate explicit action.
