# ResourcePortal Networking — LAN Attachments and Device VPN

## Private tenant Networks

Applications within the same tenant connect through explicitly authorized Docker Swarm overlay Networks. Application Network membership does not automatically grant access to customer LANs.

## LAN Attachments

LAN Attachment gives a **single RP-hosted application** a dedicated layer-2 identity in a remote customer's existing Ethernet LAN through RP Gate. The application remains hosted in ResourcePortal and obtains its own stable locally-administered MAC and an IPv4 address from the customer's **existing DHCP** server.

The path is:

```text
RP application namespace (GRETAP + DHCP)
  → RP tenant overlay
  → RP Gate gateway bridge (per application)
  → encrypted WireGuard /30 + GRETAP
  → customer's RP Gate isolated bridge
  → dedicated unnumbered Ethernet/VLAN
  → customer switch and existing DHCP server
```

No customer LAN routes, BGP advertisements, transit NAT, or site-wide routing are installed by this feature. The customer-facing Gate port must be a **dedicated, unnumbered wired Ethernet interface or isolated VLAN**. Never bridge the management interface, a Wi-Fi station client, or another application's pre-existing bridge. One application per authorized attachment; cross-tenant ownership, duplicate replicas, stale peer handshake, bridge and MAC ownership, and DHCP subnet are validated before granting the connection.

### Workflow

1. Create the application's tenant Network and deploy its App Group so it is attached to the Swarm overlay.
2. Create and enroll an RP Gate using its one-time Linux installer. A certified Gate agent must report `gate-l2-v1`.
3. Under tenant Networking → LAN Attachments, choose the application, its Network, the Gate, the dedicated LAN interface, and the expected DHCP subnet.
4. The reconciler transitions an eligible record from `Pending` to `Provisioning`. Neither state proves that DHCP worked. The RP node agent creates only the application's owned GRETAP link. The Gate accepts only a recent authenticated WireGuard peer and the expected tenant/application policy.
5. The DHCP hook accepts only leases from the approved subnet and does **not** change the application's Docker default route or resolv.conf.
6. Once independently verified, the attachment may become `Active`. Revocation must dismantle both ends of the encrypted L2 channel and preserve a durable cleanup record until the kernel confirms removal.

Disconnection, stale peer handshakes, unauthorized MACs, revoked grants, changed Docker task identities, and unavailable control planes must fail closed. A no-op status or a synthetic DHCP lease is never enough to mark an attachment healthy.

### Rollout and rollback requirements

The DB migration removes legacy routed-site resource records. Historical migrations are immutable so older installations and recovery snapshots remain reproducible. **Do not ship or auto-apply** this destructive schema change before a verified real database restore, image-level rollback, release manifest safety gates, and real Swarm DHCP/ARP/traffic/revocation integration tests. A failed cleanup must not claim completion. Device VPN is not deleted by this change.

### Real L2 verification

Run `scripts/run-remote-lan-l2-dhcp-smoke.sh` only in an isolated Linux test runner with root/sudo permissions, WireGuard, GRETAP, dnsmasq, iproute2 and BusyBox. The test provisions four network namespaces, obtains a real customer-side DHCP lease and tests ARP, connectivity, and revocation. It must be executed in release CI rather than inferred from tests that validate only command generation.


### Single-Ethernet managed RP Gate enrollment (v0.x)

The standard enrollment installer now selects the single connected physical
Ethernet interface and schedules the managed shared uplink automatically.
The same Ethernet cable carries the Gate management address, SSH, WireGuard
control-plane traffic and application-neutral Remote LAN Attachments. Neither
Wi-Fi nor VLANs nor a second adapter are required.

When multiple physical Ethernet ports are connected, the installer prompts
on the controlling terminal. Use --uplink-device DEVICE to select a port
non-interactively. Use --skip-managed-uplink to enroll without migrating
Ethernet. When an already confirmed, authenticated uplink exists, re-enrollment
does not modify the bridge again. If no usable connected physical port is
found, Gate enrollment succeeds but LAN setup remains incomplete.

On Raspberry Pi OS with NetworkManager/Netplan, the uplink tool creates
persistent native NetworkManager bridge and port profiles with deterministic
RP-owned UUIDs, high autoconnect priority and a bridge MAC matching the
original physical Ethernet. These profile names intentionally lack the
netplan- prefix, so Raspberry Pi OS stores them under
/etc/NetworkManager/system-connections and does not erase them during
Netplan regeneration. The original netplan-* Ethernet profile is not edited
or removed, allowing local or automatic restoration.

Before reparenting Ethernet, the installer persists an fsynced checkpoint,
arms an independent 120-second systemd rollback timer, and schedules both
a detached migration service and a detached authenticated auto-confirm
service. Disconnecting SSH cannot terminate the migration job.
Auto-confirm checks the physical bridge membership, saved NM identities,
DHCPv4 subnet/default route, and authenticated ResourcePortal Gate API.
An unverified migration reactivates the original wired profile. The
checkpoint and timer remain in place if an incomplete rollback needs retry,
also following reboot. Only RP-owned profiles and bridges may be removed.

LAN Attachment is explicitly application-neutral. Any eligible RP
application can be attached after a fresh trusted LAN observation appears
on the Gate; DHCP is provided by the existing customer LAN DHCP server.
The bridge remains in place across attachment add/remove operations.

## Managed Shared L2 Gateway (Gate v2)

`ManagedSharedUplink` is an opt-in alternative to a **dedicated unnumbered Ethernet port**. Applications still have separate stable MAC addresses and isolated L2 GRETAP tunnels through the existing authenticated WireGuard transport. The remote Gate's **physical management Ethernet** becomes a port of one persistent, RP-owned Linux bridge; the Gate's own DHCPv4 management address, default route and DNS are assigned to the bridge. The bridge is owned independently of individual application attachments and must not be deleted when the final attachment is revoked.

### Gate host configuration

Supported automatic migration requires a unique wired DHCPv4 management NIC,
a verified IPv4 gateway, a dedicated RP-owned bridge identity and no global
IPv6 or foreign bridge/VLAN. The networkd backend keeps its explicit,
device-specific .network file. On Raspberry Pi OS Trixie, the Netplan profile
is recognized in read-only preflight but a detached native NetworkManager
backend creates the RP-owned persistent profiles without editing the original
netplan-* Ethernet configuration. Higher-priority RP port autoconnect keeps
the same physical NIC available after reboot. Wi-Fi is not required, altered
or bridged.

1. Run the standard Gate enrollment one-liner. The installer identifies the
   physical Ethernet and prompts only if several connected wired NICs qualify.
   The Gate is enrolled and its managed uplink prepared by the same command.
2. The installer arms the persistent systemd watchdog and schedules detached
   migration plus authenticated automatic confirmation. SSH may disconnect.
   Do not interrupt the watchdog or remove the checkpoint manually.
3. Confirm by reading the live Gate status and observed LAN in ResourcePortal.
   The automatic verifier checks DHCPv4, the default route and HTTPS RP auth.
   If proof cannot be obtained before the watchdog deadline, the previous
   NetworkManager Ethernet profile is reactivated.
4. For diagnostics or manual recovery use the installed uplink command
   with status, preflight, confirm or rollback. No direct netplan apply is
   required on Raspberry Pi OS.

5. The Gate v2 heartbeat reports a fresh, versioned and machine-authenticated *observed LAN*, including real IPv4 subnet, mask, gateway, bridge, uplink and capture time. RP never accepts tenant-supplied CIDR values as evidence of a prepared managed bridge. Missing/stale Gate observation blocks new managed attachments and revokes stale grants.

### Application addressing

In tenant Networking → LAN Attachments, select **Managed shared uplink** and a Gate with a fresh verified observation. The LAN prefix and physical interface are read-only from the Gate. Choose **DHCP** (from the customer's existing DHCP server) or **Static IPv4** with an explicit host address/prefix and a custom on-link gateway. Static IPv4 runs inside that application's network namespace with source-specific policy routing, leaving the Docker overlay default route untouched. Edit an existing attachment's DHCP/Static assignment through the audited PATCH addressing API; a change increments the configuration revision and reconciles the old endpoint before granting a replacement. Revocation does not remove the persistent Gate management bridge.

The dedicated unnumbered port mode remains available for existing deployments. It continues to accept an expected DHCP subnet and does not require host management NIC migration.

**Activation proof implementation (not yet release-certified):** The worker now combines fresh observations from two separate trusted sources. The privileged node agent observes the running application namespace, verifies GRETAP ownership/MAC/overlay peer and unchanged Docker default route, and reports a real DHCP ACK lease or Static source-specific route through Docker Swarm service logs bound to the currently running agent task. The enrolled Gate reports its own WireGuard handshake, bridge ownership and learned application MAC over its authenticated machine-token heartbeat. The worker validates tenant/application/Gate identity, attachment revision, lease expiry and Static address/gateway before advancing `Provisioning` to `Active`. An `Active` record loses its status when current evidence disappears. `Revoking` becomes `Revoked` only after a Gate applied-state acknowledgement newer than the revocation and successful empty reconciliation from every current node agent. Missing, stale, duplicated or mismatched proof fails closed.

**Remaining release blocker:** This control-plane integration has unit tests but must still pass the official privileged **end-to-end** multi-node/multi-app DHCP/Static activation, Gate/networkd cold-reboot/watchdog recovery and revocation suite. A successful WireGuard tunnel, local proof unit test or `Pending`→`Provisioning` transition alone is not sufficient. Do not enable the feature in production or claim the release DoD until the official checks, source PostgreSQL/ZITADEL restore evidence and signed release artifacts are verified.

### Release and verification safeguards

The new fields include a Prisma migration; the automatic release policy **forbids release** until a certified control-plane database restore/rollback is proven. Unit/mock tests and a generated policy are not certification of a live host's management migration. Run a privileged disposable Linux runner with networkd, cold reboot/recovery, real WireGuard/GRETAP/Swarm DHCP and Static tests, ARP, TCP/UDP, MAC anti-spoofing and revocation, followed by all mandatory release gate checks. Do not disable the restore gate or advertise a published version before the required evidence exists.

## Device VPN

Device VPN is distinct: each user device obtains its own WireGuard configuration with a unique /32 address. Only its selected RP tenant Network prefixes are authorized; it does not attach a customer's entire LAN and never inherits access from LAN Attachment. Keep Device VPN's existing enrollment, audit, isolation and revocation behavior unchanged.
