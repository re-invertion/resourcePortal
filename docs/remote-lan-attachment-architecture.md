# Remote LAN Attachment — implementation contract (work in progress)

## Goal and boundary

Replace **Site VPN** (routed L3 links between tenant networks and remote LANs)
with explicit **Remote LAN Attachments**: a *single tenant application* running
in RP receives an Ethernet interface logically on a selected RP Gate LAN, with
an actual lease from the customer's DHCP server. ResourcePortal itself remains
in the operator infrastructure; only RP Gate is installed at the customer's
premises. Device VPN must remain independent.

This is a breaking change. Site VPN must not simply be renamed or re-used:
a WireGuard L3 route does not forward DHCP broadcasts, ARP or multicast as Ethernet.

## Architecture

- Transport: authenticated WireGuard underlay per customer Gate, with
  isolated Ethernet-over-IP tunnel (e.g. GRETAP or VXLAN) per selected
  application/LAN segment; never accept L2 from the public internet.
- Gate: dedicated explicit Ethernet interface/VLAN chosen by admin. Do not
  silently enslave an interface carrying management IP/default route into a
  bridge. Gate must inspect link topology before any mutation; refuse Wi-Fi
  client mode without known support for four-address bridging. The initial
  implementation must fail closed when the Gate offers only its management
  Ethernet NIC: a separate NIC or explicitly provisioned VLAN is mandatory.
- RP: node-local attachment controller binds a single service/task's dedicated
  veth/tap/namespace to an isolated L2 tunnel. A generic Swarm overlay
  route is **not** an acceptable substitute. Survive scheduling changes by
  revoking old attachment before re-creating on its new node.
- DHCP: frames DHCPDISCOVER/OFFER/REQUEST/ACK traverse the encrypted L2 path.
  Server is the customer's existing DHCP server, not Docker IPAM. Reserve a
  locally administered unicast MAC for the application, retaining it over
  application/agent restarts.
- Isolation: each attachment is bound to tenant ID, application ID and Gate ID.
  No cross-Gate or cross-tenant L2 bridging. Enforce source MAC spoof protection,
  disable unintended IP forwarding and RA; block RP management interfaces,
  prevent STP loops and do not bridge the entire RP overlay with a customer LAN.
  One application replica per attachment until multi-replica semantics exist.
- Availability: fail closed on Gate agent/runtime version mismatches, stale
  handshake, missing bridge confirmation, DHCP timeout or Swarm node movement.
  Publish 'Active' only after RP- and Gate-side proof and a verified DHCP lease.
- Runtime reconciliation: idempotent attach and detach; remove virtual links,
  peer state, bridge memberships, DHCP leases and firewall rules after revocation.
  Keep a durable revoking tombstone until cleanup succeeds.
- Work-in-progress implementation: `remote-lan-node.runner.ts` and
  `remote-lan-gateway-plan.ts` provide the node-local agent and gateway bridge
  plans; the Gate installer bundles `gate-lan-agent.py`. Do not activate these
  agents until the authenticated desired-state transport, remote DHCP evidence,
  real Swarm test, and rollback certification are complete. The DHCP hook
  deliberately does not override the application's Docker default route.

## DHCP hook authorization boundary

The node-local Swarm policy now carries the tenant-approved, normalized
`lanCidr` alongside the attachment identity and stable MAC. The node agent
passes that CIDR to the application's `udhcpc` hook as
`RP_REMOTE_LAN_CIDR`; it is **not** taken from DHCP options or user-controlled
container environment. A missing or malformed policy fails closed.

Before changing any address, the hook verifies that the offered mask exactly
matches the approved prefix (/16–/30), the offered IPv4 address belongs to that
subnet, and it is neither its network nor broadcast address. A renewal removes
any previous address on the RP-owned interface before installing the new lease;
DHCP routes, default gateway and DNS options are never applied. This local
check is defense in depth, **not** proof of a trusted DHCP server: activating an
attachment still requires independently authenticated, contemporaneous Gate
and app observations and the real encrypted L2 dataplane tests.

Run `python3 test/installer/test-remote-lan-dhcp.py` for the isolated hook
regression and `bash scripts/run-remote-lan-l2-dhcp-smoke.sh` on a disposable
privileged Linux runner with WireGuard, GRETAP, dnsmasq and namespace support.
Neither test alone certifies tenant isolation on production Swarm or the release
rollback requirements.

## Migration and retirement

1. Deploy and validate the new dataplane in isolated multi-node real Swarm and
   a remote Gate test host, including DHCP success and broadcast/mDNS delivery.
2. Revoke and stop legacy Site VPN routes, BGP exports, discovery relay and
   RP-to-LAN firewall policy; verify stale routes and peers are removed.
3. Convert only explicitly selected applications to Remote LAN Attachment.
   **Do not infer L2 intent** from previous broad Site VPN access grants.
4. Remove retired control-plane APIs, UI graph nodes/actions, CLI paths, old
   runtime stacks, routes, Gate network attachment rows, credentials and
   schema fields. Preserve unrelated tenant Networks, Device VPN and audit log.
5. Only after verified database backup/restore and fault-injected rollback
   smoke, run destructive schema migration and release.

The current release gate in docs/release-validation-policy.md explicitly
rejects Prisma migrations and schema-changing releases without independently
validated automatic DB restore. Do not bypass it by relabeling as Fast Fix.

## Completion criteria

- E2E: a customer DHCP server sees the application's stable MAC and allocates
  IP in the remote subnet; app and another LAN host exchange IP and ARP.
- E2E: isolation across two tenants with **overlapping** RFC1918 CIDRs.
- E2E: reboot/restart, failover, lease renewal and revocation remove stale
  links and old network access.
- Security: cannot inject tagged frames for other tenants, spoof MAC,
  attach a physical management NIC, or reach RP control-plane interfaces.
- Operations: old Site VPN endpoints/UI and old desired runtime no longer
  exist; migration leaves no old secrets or operational links.
- Release: signed, SHA-pinned automatic release after required merge queue,
  full regression and verified database rollback. No manual bypass.
