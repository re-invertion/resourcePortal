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

## Gateway proof refresh and critical worker scheduling (issue #396)

**Gateway transport configuration vs observed proof.** Swarm's gateway
`RP_GATE_CONFIG_B64` and `resourceportal.gate.digest` contain only
authorized, revisioned topology, identity, address mode and explicit static
IPv4 policy. `status`, DHCP `verifiedAddress`, `leaseExpiresAt` and
`lastVerifiedAt` are deliberately excluded from service-spec comparison.
An ordinary `Provisioning → Active` transition or successful proof refresh
must not update the service spec, generate a new Swarm gateway task or restart
WireGuard/GRETAP. A change to tenant/Gate/network, MAC, attachment revision,
network policy or other actual transport configuration still demands a
controlled, fail-closed rollout.

**Dynamic source enforcement.** The trusted worker uses Docker's local
container exec channel to send a short-lived, identity-bound snapshot to
`remote-lan-gateway-policy.runner.ts` inside the *already running*
gateway. The gateway rejects mismatched Gate, tenant, attachment, network,
MAC, configuration revision, stale timestamp and duplicate grants. Policy
is written as a mode-0600 atomic replacement in the gateway's private
`/run` filesystem and is never exposed on a new network port, API endpoint
or bind mount. Snapshots are read again before each runtime bridge
reconciliation; leases are bounded by the authenticated 45-second proof
freshness limit **and** the actual DHCP expiry. An empty, missing, expired
or invalid DHCP grant keeps the `nftables` IPv4 source set empty; only
DHCP bootstrap and RFC5227 ARP probes pass. An authenticated static IPv4
grant remains bounded to its explicit address. Source-set changes are
performed with a single `nft -f` transaction, without detaching the
existing GRETAP ports; transaction failure revokes the RP-owned tunnel.

The *physical* `gate-l2-v3` agent applies the same dynamic set update
when only verified status, IP or lease changes. It still verifies the
exact WireGuard peer/handshake, LAN ownership, tenant, MAC, revision and
host-management bridge safety. A true revisioned topology change remains
a fail-closed detach/recreate. The updated Gate agent must be installed
through the supported Gate update procedure **after** the corresponding RP
release; never overwrite a production Gate or Raspberry Pi during CI.
Older Gate binaries may still detach their local tunnel during a policy
refresh until they are upgraded.

**Worker concurrency.** A dedicated serial lane begins critical
`gateRuntime → remoteLanLifecycle → remoteLanNode + Activation`
reconciliation before unrelated startup volume scans. The background lane
continues to own volume/certificate/ingress/drift work. Each critical
reconciler is single-flight: no unbounded queue and no overlapping invocation
within a worker. Execution errors are reported independently and subsequent
cycles recover; SIGTERM aborts new cycles. Volume traversal checks the abort
signal between filesystem operations. Existing reconciliation duration,
success and error observations remain in the worker database, while
structured events `worker.critical_reconcile.scheduler_delay` include
`delayMs`, `missedCycles`, and (on overrun) `durationMs`.
`WORKER_ONCE` still disables background reconciliation.

### Diagnostic procedure (read-only)

1. Record the exact RP version and Gate agent version, attachment revision,
   status and timestamps. Check for a *real* authenticated WireGuard peer
   handshake plus Gate-side and Node-side proofs; do not infer validity from
   a UI `Active` label.
2. Compare the gateway's Swarm task IDs across several worker cycles with
   `docker service ps --no-trunc <gateway-service>`. Read only its
   `resourceportal.gate.digest` label with `docker service inspect`.
   A state-only proof refresh should not change either.
3. Correlate `worker.critical_reconcile.scheduler_delay` and normal
   `worker.reconcile.*` duration/error logs with timestamped
   `volumeUsage` runs. A multi-minute volume scan must not suppress Gate,
   Node or Activation cycles.
4. On a disposable test system check `nft list set bridge rp_lan_gw <set>`
   and the physical Gate's `rp_lan` source set during DHCP bootstrap,
   Active, renewal, changed address and expiry. Reject traffic from any
   unauthorized source, including after proof expiry. Do not manually edit
   production `nftables` or set the attachment status in SQL.
5. Test a genuine policy revision and Swarm task replacement separately,
   verifying convergence only after fresh proof. During an authorized rollout,
   transient `Provisioning` is correct; synthetic `Active` is forbidden.
6. Validate in isolated real Swarm with WireGuard, GRETAP and customer-side
   DHCP or Static IPv4 using `scripts/run-remote-lan-l2-dhcp-smoke.sh`,
   `scripts/run-remote-lan-gateway-sysctl-swarm-smoke.sh` and release
   readiness / automatic rollback gates. Unit tests, including a simulated
   365-second filesystem scan, are not substitutes for packet-level proof.

**Rollback:** no database schema migration is required for this change.
Rollback to the immediately preceding *officially published* RP release
must pass the mandatory image-level rollback smoke. New dynamic policy and
Gateway agent behaviour are release-coupled; verify the supported Gate-agent
upgrade/rollback instructions before any live host work. Production RP and
physical Gate updates are explicitly outside the agent's release task.

## Bounded Remote LAN control-plane continuity (#422)

A transient external HTTPS heartbeat error (including ingress 404/502)
must not immediately tear down a previously authorized v4 Gate data plane.
The new **authorization lease** is scoped per Gate, tenant, attachment and
configuration revision, is separate from the DHCP lease, and is limited
to a candidate **600 seconds**. It is not valid for new or revised
attachments. The physical Gate uses a monotonic fail-closed watchdog and
kernel-expiring source rules; the Swarm Gateway enforces its own bounded
source rule. Authenticated revocations and policy changes take immediate
effect where delivered. A partitioned Gate cannot observe a revocation
before its bounded lease expires.

This feature requires RP release support *and* an explicit in-place
upgrade to Gate v4; older agents retain their original fail-closed behavior.
Full design, threat model, security review requirement, test cases and
rollback procedure: [Authorization Lease (#422)](remote-lan-authorization-lease-422.md).
Do not update a live Gate/Pi or Home Assistant during isolated CI.
