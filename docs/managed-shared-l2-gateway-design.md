# Managed Shared L2 Gateway — technical design and acceptance gates

Status: design in progress; not implemented or released. Baseline: main `1e4436d88ae3fd1ed186fc3fc69a00eb0da74260` (2026-10-24).

## Baseline and incompatibilities

Existing `RemoteLanAttachment` Prisma model contains `lanCidr`, `lanInterface`, `dhcpAddress` and one per-app stable MAC, but no DHCP/static mode, static address, static gateway, segment observation provenance or versioned capability contract. Existing `assertSafeGateLanInterface` rejects any IP on the physical uplink, and `gateLanBridgeCleanup` deletes its RP bridge on last attachment: both are incompatible with the managed shared uplink lifecycle. Existing dedicated unnumbered Ethernet mode MUST remain unchanged.

## Design

1. Define explicit Gate uplink modes `DedicatedUnnumbered` and `ManagedSharedUplink`. Never infer the new mode from an existing device or silently convert an installation.
2. Keep a Gate-owned *persistent segment bridge* as a separately reconciled resource, independent of any LAN attachment. Reuse one segment bridge per selected verified physical uplink; do not delete on last attachment. Retain the existing dedicated mode's safe ownership rules.
3. For a managed uplink, the privileged installer must collect systemd-networkd/NetworkManager/dhcpcd/network interfaces ownership, IPv4/IPv6 addresses, default routes, DNS, bridges, VLANs, kernel capability and remote-management paths before accepting the migration. Reject unsupported multi-manager and Wi-Fi station setups.
4. Stage network-manager-native persistent bridge configuration with a durable checkpoint and external, systemd-managed rollback watchdog **before** moving physical uplink membership, IPv4, IPv6, routes and DNS. The watchdog must restore the original config without relying on SSH/Control Plane connectivity. Verify gateway access, DNS and RP Gate control-plane heartbeat before acknowledging readiness; verify after cold reboot in a real Linux harness.
5. Gate reports versioned observed segment id, bridge, physical interface, IPv4 CIDR/prefix, gateway (when verified), discovery method/time, capability/agent revision and health. Reports require Gate authentication, freshness, coherency checks and replay protection. Unknown/unverified subnet => fail-closed attachment authorization.
6. Preserve one stable MAC and GRETAP identity per attachment. Keep the encrypted WireGuard underlay shared while ensuring per-app ownership, anti-spoofing, isolated segments and no rogue DHCP/RA, VLAN tags or unauthorized L2 forwarding. Do not treat shared customer LAN as isolation between mutually untrusted tenants.
7. `DHCP` uses the physical LAN's DHCP server from the application netns; verify observed lease and renew after restart. `Static` accepts only application IPv4 and custom gateway; use Gate-reported prefix, reject collisions and unsafe/stale observations, apply in application namespace. Preserve Docker default route unless an independently authorized egress policy exists. Changing modes must be transactional and recoverable.
8. A schema-changing Prisma migration cannot be published under current `docs/release-validation-policy.md` until certified database restore is implemented. Implement and prove the restore capability before such a release or develop a genuinely schema-neutral compatibility model that passes official gates, without misclassification.

## Acceptance evidence

- Unit/API: subnet/gateway/ownership, stale and inconsistent reports, address collision, DHCP/static transition, MAC identity, cleanup idempotency, revocation.
- Real Debian/Raspberry Pi OS: bare-host install, management NIC migration, DHCP/static multi-app, two GRETAPs, cold reboot, lost-SSH rollback watchdog, update and uninstall, no unexpected foreign interface deletion.
- Real isolated Swarm/WireGuard: bidirectional TCP/UDP, ARP/mDNS/SSDP, DHCP lease, static address and custom gateway, reconnect and task replacement, spoofing/cross-tenant negative tests, IPv6/RA, VLAN, MTU and teardown.
- All mandatory `npm run lint`, `npm run test`, `npm run build`, `npm run test:installer`, `npm run test:cli-release`, live network and automatic release rollback checks must pass.
- Only PR approvals + protected Merge Queue + official SHA-pinned main release can mark delivery complete. Publish release without deploying production. Include PR SHA, CI URLs, signed manifest, immutable GHCR digests and rollback logs.

**Safety:** Until certified, managed uplink is not offered as Ready and no host NIC migration is performed in production.
