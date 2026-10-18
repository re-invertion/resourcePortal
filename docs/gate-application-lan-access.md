# Generic application LAN access through ResourcePortal Gate

ResourcePortal's Site VPN provides reusable, opt-in LAN connectivity to an
individual SingleApp, independently of its software image (automation platforms,
DNS tools, monitoring agents or management services).
It does not enable tenant-wide LAN access by default.

## Components and safeguards

- Application routes: a host-local app-lan-router Swarm global agent reads
  worker desired state and configures Linux IPv4 routes inside the application
  network namespace. It uses the running Gate task's overlay address as next
  hop. Tenant containers need neither host networking nor CAP_NET_ADMIN. The
  agent periodically reconciles/removes its own routes (protocol 201).
- Per-application ACL: PerApplication Site VPN mode permits only the approved
  SingleApp task source addresses, destination IPv4 CIDRs, TCP/UDP protocol,
  and destination port. FORWARD and SNAT rules are applied atomically.
  Empty rules deny all. Missing tasks, detached apps, or invalid saved rules
  do not yield wildcard grants. Existing Legacy gates retain their prior
  policy until an administrator explicitly configures application access.
- mDNS/SSDP discovery: scoped opt-in query/response forwarding over the
  existing WireGuard tunnel via UDP 53540. This is not an L2 bridge.
  Discovery screening, source validation, session expiry, response limits,
  and packet rate/size limits prevent general-purpose multicast bridging.
  SSDP NOTIFY and unsolicited responses are not forwarded. Agents must
  report discovery capability version 1 before rules can be granted.

Global platform egress restrictions still apply. Do not remove default
private-address restrictions to grant a single application network access.

## Configuration

1. Attach the Site VPN and SingleApp to the same tenant Network.
2. Confirm the Gate is Ready. Re-enroll/reinstall an older Gate agent before
   enabling discovery relay, if the reported capability is missing.
3. In Networking > Site VPN > App access, select an application attachment
   and grant only needed destination CIDR, protocol and port combinations.
4. In Firewall, enable RP -> LAN if this traffic is intended.
   In PerApplication mode, this cannot override the app-specific ACL.
5. Optionally use Discovery to grant mDNS and/or SSDP to selected SingleApps.

Ordinary HTTPS ingress and storage are separate. Matter/Thread IPv6 support,
non-network peripherals, USB and Bluetooth passthrough are out of scope.

## Release verification

Run builds, Prisma migration validation, networking tests, and the real
Swarm Site VPN dataplane smoke. It verifies legacy deny, authorized
SingleApp-to-LAN TCP 8090 and denied TCP 8091, LAN-to-RP behavior,
and restart/revoke safety. The smoke injects a route in its isolated
namespace to test the WireGuard/firewall path. The global route-agent
and the mDNS/SSDP paths still require end-to-end staging tests before
being declared production proven. Multicast transport inside Docker Swarm
overlays depends on the environment and integration.

## Failure handling and rollback

Every new rule is opt-in. The additive database migration starts with
empty policies and preserves existing Gate settings. Removing permission
or an attachment reconciles its routes and firewall grants away.
Revoking the Gate closes the tunnel. Release rollback must cover API,
worker and Swarm service versions; do not manually drop the new schema
columns when reverting only the application version.
