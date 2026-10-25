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

## Managed Shared L2 Gateway (Gate v2)

`ManagedSharedUplink` is an opt-in alternative to a **dedicated unnumbered Ethernet port**. Applications still have separate stable MAC addresses and isolated L2 GRETAP tunnels through the existing authenticated WireGuard transport. The remote Gate's **physical management Ethernet** becomes a port of one persistent, RP-owned Linux bridge; the Gate's own DHCPv4 management address, default route and DNS are assigned to the bridge. The bridge is owned independently of individual application attachments and must not be deleted when the final attachment is revoked.

### Gate host configuration

Supported automatic migration requires a wired DHCPv4 management NIC without global IPv6, VLAN trunks or foreign bridges. Two fail-closed backends are supported:\n\n- **systemd-networkd:** a unique device-specific `.network` file in `/etc/systemd/network`, no competing manager.\n- **Netplan + NetworkManager:** A simple `netplan-eth0` DHCPv4 configuration is allowed for read-only preflight. Raspberry Pi OS/Debian 13 may generate `match: {}`, `dhcp6: true`, and `networkmanager: {uuid, name, passthrough: {proxy._: ""}}`. The preflight now validates that metadata against the *currently connected* NetworkManager UUID and proves there is **no global IPv6 address or IPv6 default route**. DHCPv6 being enabled in the profile is not evidence of an active IPv6 lease. A second default route on Wi-Fi is accepted only with a **strictly higher metric** than Ethernet; Wi-Fi is never bridged or modified by the helper. Any additional profile passthrough, nonempty `match`, VLAN/bond, custom Ethernet routes or active global IPv6 still fails closed.
- **Raspberry Pi OS safeguard:** Pi OS's NetworkManager can rewrite or remove `/etc/netplan` YAML. Netplan `apply` may also retain orphan kernel bridge devices after a rollback. The currently implemented Netplan drop-in/watchdog method **is not sufficient to certify recovery on Pi OS**. On an RP Gate running an `rpt-rpi` kernel, `preflight` reports `applySupported: false` and `apply` refuses the migration even if requested with confirmation. This protects SSH-only installations from losing their management network. Do not bypass this guard by running `netplan apply` or manually bridging `eth0`. Use a separately configured *dedicated* Ethernet/VLAN port (kept unnumbered, without impacting the management NIC) if immediate LAN Attachment is required, or postpone until a separately tested Pi OS recovery implementation is released.
- **Other NetworkManager installations:** `apply` requires an explicit `--confirm-local-recovery` acknowledgement after verifying physical/out-of-band access. This flag is not a replacement for actual recovery access. The systemd-networkd path is unchanged.

1. Install/update the Gate with the standard `install.sh`. The installer installs `/usr/local/sbin/resourceportal-gate-uplink`; no physical interface is migrated automatically.
2. On the Gate host run `sudo resourceportal-gate-uplink preflight --device eth0`. Inspect its `manager`, physical device, observed IPv4 CIDR, gateway and `routeMetric`. The command does not change the network. For a Pi with `netplan-eth0` and Wi-Fi in the same subnet, verify that the Ethernet default route has a strictly lower metric than Wi-Fi.
3. Only if the *read-only* preflight reports `applySupported: true` and genuine physical/out-of-band access is available, proceed with migration. NetworkManager installs require `sudo resourceportal-gate-uplink apply --device eth0 --confirm-local-recovery`; the systemd-networkd path retains `sudo resourceportal-gate-uplink apply --device eth0`. Never use this command on Raspberry Pi OS with `applySupported: false` or with SSH-only access. A persistent systemd watchdog and checkpoint are created **before** modifying Netplan or networkd. NetworkManager hosts apply the isolated Netplan override via `netplan generate` / `netplan apply`. This may interrupt BOTH Ethernet and Wi-Fi during reprovisioning: do not depend on Wi-Fi being a guaranteed recovery path. An unconfirmed migration is rolled back automatically, including after reboot. Never stop NetworkManager or switch renderers manually.
4. After verifying actual management connectivity, run `sudo resourceportal-gate-uplink confirm` on the host **before the watchdog's 120-second deadline**. Confirmation checks the bridge's physical member, live IPv4 subnet/default route, the persistent RP-owned Netplan or networkd source and an authenticated HTTPS call to RP. `sudo resourceportal-gate-uplink rollback` restores the original configuration; an incomplete rollback retains its checkpoint so the watchdog can retry.
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
