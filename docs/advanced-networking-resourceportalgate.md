# Advanced Networking: Site VPN and Device VPN

Status: implemented.

## Scope

Advanced Networking provides tenant-scoped `Network` resources, automatic App Group networks, **Site VPN** and **Device VPN**.

The existing `ResourcePortalGate` resource remains the internal/API compatibility name for **Site VPN**. Existing Gate database records, API routes, installers and deployments continue to work after upgrade.

The current implementation provides:

- private tenant Networks that may connect applications across multiple App Groups in the same tenant,
- stable per-application addresses on each Network,
- **Site VPN** for routing an entire LAN to selected ResourcePortal Networks,
- one Site VPN attached to multiple tenant Networks,
- manual static-route guidance for LAN routers,
- optional automatic export-only eBGP route advertisement from the LAN-side Site VPN,
- **Device VPN** for connecting an individual laptop, workstation or phone directly to selected tenant Networks,
- one shared RP-side WireGuard concentrator for Device VPN peers,
- per-device `/32` addresses and server-enforced Network allow-lists,
- one-time WireGuard configuration delivery with QR and `.conf` download,
- React Flow topology plus list/table fallback,
- durable topology Operations with optimistic concurrency.

It intentionally does **not** provide private DNS/service discovery, L2 extension, proxy ARP, automatic import of LAN routes, automatic RP → whole-LAN access, or full-tunnel Internet access through Device VPN.

## Site VPN (ResourcePortalGate)

Site VPN is the existing ResourcePortalGate data plane. It runs as an RP-side gateway stack plus a small LAN-side systemd agent. WireGuard carries routed traffic between that LAN host and the selected tenant Networks.

The normal path is:

`LAN client → LAN router → Site VPN LAN IP → WireGuard → RP Site VPN runtime → selected RP Network → application stable IP`

The reverse direction to arbitrary LAN ranges is not granted automatically.

### Site VPN addressing and routing

ResourcePortal allocates separate stable-address, overlay and Site VPN tunnel CIDRs. A Site VPN reports its LAN addresses/CIDRs during enrollment and heartbeat.

Each Site VPN has one route-advertisement mode:

- **Manual** — configure a static route for each exported RP Network CIDR with the Site VPN LAN address as next hop.
- **BGP** — the LAN-side agent runs FRRouting (FRR) and establishes eBGP to the configured LAN router. ResourcePortal automatically derives exported prefixes from active `GateNetworkAttachment` records.

There is no BGP API field for arbitrary advertised prefixes. The desired `advertisedCidrs` list is generated from Networks currently attached to the Site VPN. Removing an attachment removes that CIDR from desired BGP state.

The generated FRR policy is export-only:

- `RP-GATE-EXPORT` explicitly permits only attached RP Network CIDRs and ends with `deny any`;
- `RP-GATE-IMPORT` denies all received IPv4 prefixes;
- no connected, kernel, static or dynamic routing protocol is redistributed into BGP;
- the configured LAN router address must belong to a LAN CIDR reported by the Site VPN;
- when provided, the BGP source address must be one of the Site VPN's reported LAN addresses;
- Site VPN and router ASNs must differ, so managed mode is eBGP.

FRR keeps normal BGP network import-check behavior. An RP prefix is advertised only while the corresponding route exists on the Site VPN host. Because WireGuard `AllowedIPs` installs those RP routes, a tunnel failure naturally withdraws the advertisement.

Site VPN peers use UDP ports `52000-52999`. Production firewalls and any upstream NAT/router must forward this range to the ResourcePortal ingress/control-plane host. The installer manages the matching UFW rule on ingress nodes and refreshes it during upgrades.

CIDR overlap between a Site VPN LAN and an attached RP Network is rejected.

### Site VPN enrollment and revocation

1. Create **Site VPN** in tenant Networking.
2. Copy the one-time installer command.
3. Run it as root on a Linux host with systemd in the target LAN.
4. The installer installs `curl`, `jq`, WireGuard tooling, iproute2 and iptables, creates a local WireGuard private key and enrolls once. FRR is installed lazily only when BGP is enabled.
5. Enrollment exchanges the one-time token for an agent token. Only SHA-256 of the agent token is stored server-side.
6. The agent heartbeats, reports LAN addresses/CIDRs and receives desired WireGuard and route-advertisement configuration.
7. Attach Site VPN to selected Networks.
8. Optionally switch route advertisement from Manual to BGP.
9. Revoke/delete Site VPN to invalidate the agent token and remove the RP-side WireGuard stack and managed BGP state.

Enrollment tokens are one-time and expiring. Rotating enrollment invalidates prior unused enrollment material.

### FRR ownership boundary

The Site VPN agent owns only the configuration block marked:

`! BEGIN RESOURCEPORTAL-GATE` … `! END RESOURCEPORTAL-GATE`

Existing non-BGP FRR configuration outside that block is preserved. If the host already contains an unmanaged `router bgp ...` stanza outside the ResourcePortal block, the agent refuses BGP reconciliation instead of taking over an existing BGP control plane.

## Device VPN

Device VPN is separate from Site VPN. It does not require installing ResourcePortalGate in the device's local network.

The normal path is:

`device → Internet/LAN → WireGuard UDP/51820 → shared RP Device VPN concentrator → explicitly allowed RP Network → application stable IP`

Device VPN uses a dedicated address pool, default `100.64.0.0/11`. The concentrator defaults to `100.64.0.1/11`; devices receive unique `/32` addresses beginning at `100.64.0.2/32`. This pool does not overlap the default Site VPN tunnel pool `100.96.0.0/11`.

The public Device VPN endpoint is configured with `RESOURCEPORTAL_DEVICE_VPN_ENDPOINT_HOST`; it falls back to the Site VPN Gate endpoint/public ResourcePortal hostname. The public UDP port defaults to `51820`.

Production ingress nodes open UDP/51820 through the installer-managed UFW rules. Any external NAT/firewall in front of ResourcePortal must also forward UDP/51820 to the ingress/control-plane host.

### Device creation and configuration

In tenant Networking:

1. Open **Device VPN**.
2. Choose **Add Device VPN**.
3. Enter a device name.
4. Select one or more tenant Networks.
5. ResourcePortal creates a WireGuard keypair and a unique Device VPN `/32`.
6. The Web Console displays the WireGuard configuration once as text, QR code and downloadable `.conf`.
7. Import it into a standard WireGuard client on Windows, macOS, Linux, Android or iOS.

The device private key is **not stored** by ResourcePortal. Only its public key is persisted. If the one-time configuration is lost, revoke the device and create a replacement.

The generated client `AllowedIPs` list contains only the selected ResourcePortal Network CIDRs. It never contains `0.0.0.0/0` by default.

### Device VPN server-side isolation

Client-side `AllowedIPs` is not treated as an authorization boundary. The concentrator also enforces access server-side:

- each WireGuard peer is pinned to exactly its assigned source `/32`;
- DNAT from a stable application address to its overlay target is created only for Networks assigned to that device;
- forwarding rules match both the device source `/32` and the authorized application target;
- SNAT is scoped to that device and authorized overlay;
- all other traffic entering or leaving the Device VPN WireGuard interface is rejected.

Therefore changing routes or `AllowedIPs` locally on the client does not grant access to another tenant Network.

The concentrator may attach to the union of Networks needed by active Device VPN peers, but the source-address firewall remains the authorization boundary between peers and those Networks.

Device VPN does not grant:

- access to Networks not explicitly assigned to the device,
- access to another tenant,
- implicit access to a Site VPN LAN,
- arbitrary ResourcePortal control-plane access,
- Internet forwarding/full-tunnel VPN service.

### Device status and revocation

The Device VPN runtime reports WireGuard latest-handshake timestamps through a dedicated runtime token. The Web Console uses that state for `lastSeenAt`.

Revoking a Device VPN marks the peer revoked, increments desired-state revision and removes it from the shared WireGuard concentrator on the next reconciliation. The old `.conf` then stops working.

Network deletion is blocked while Device VPN access still references that Network, just as it is blocked for application and Site VPN attachments.

## Threat model and boundaries

The implementation is designed around these constraints:

- tenant isolation is enforced by tenant-scoped Network lookups, RBAC and device ownership;
- cross-tenant application/Site VPN attachment is rejected;
- Device VPN creation accepts only Networks from the authenticated tenant;
- Site VPN private keys are encrypted in ResourcePortal storage and provisioned as versioned Docker secrets;
- the Device VPN server private key and runtime token are encrypted at rest and provisioned as Docker secrets;
- Device VPN client private keys are never persisted by ResourcePortal;
- the Site VPN LAN agent does not receive Docker socket access or control-plane secrets;
- BGP never imports LAN routes into ResourcePortal;
- only active Site VPN → Network attachments can become BGP export prefixes;
- Device VPN uses explicit per-device Network allow-lists and source-`/32` firewall enforcement;
- revocation removes the corresponding WireGuard access;
- Site VPN does not create an implicit route from RP workloads to all LAN destinations;
- Device VPN does not provide full-tunnel Internet routing;
- topology mutations use `expectedRevision`; stale clients receive conflict rather than overwriting newer topology;
- Network deletion is staged as `Deleting` and cannot bypass active application, Site VPN or Device VPN references.

## Current network model

Every deployed App Group has its own automatic overlay network. Tenant-scoped `Network` resources add explicit cross-App-Group connectivity.

Access paths are intentionally separate:

- application ↔ Network — application private connectivity,
- Site VPN ↔ Network — LAN/site access,
- Device VPN device ↔ Network — individual device access.

The Networking canvas continues to render application and Site VPN topology. Device VPN is managed as a device/access list because each device is an identity-bound access peer rather than a site topology router.

## Upgrade safety

Existing `ResourcePortalGate` records and API routes are retained and presented as **Site VPN** in the Web Console. No existing Site VPN is converted into a Device VPN.

The Device VPN migration only adds new tables, indexes, permissions and relations. Existing Gate/BGP state is not rewritten.

Default pools are non-overlapping:

- Device VPN: `100.64.0.0/11`
- Site VPN: `100.96.0.0/11`

## Verification

The implementation is covered by:

- Prisma schema validation and migration checks,
- Device VPN address allocation/non-overlap tests,
- backend lifecycle tests for create/revoke, audit and ownership,
- tests proving the private client key is not persisted,
- WireGuard setup tests pinning every device peer to its own `/32`,
- firewall tests proving one peer cannot reach a Network assigned only to another peer,
- shared concentrator stack rendering/digest tests,
- Site VPN BGP and lifecycle regression tests,
- Web Console tests for Site VPN naming and Device VPN creation/revocation,
- QR/config generation tests,
- installer firewall tests for UDP/51820 plus the existing Site VPN UDP range,
- full repository lint, build and unit/integration test gates.

Reusable real-data-plane smoke runners:

- Site VPN: `scripts/run-gate-dataplane-smoke.sh`
- Device VPN: `scripts/run-device-vpn-dataplane-smoke.sh`

The Device VPN smoke deliberately gives one client routes to two RP Networks while authorizing it for only one and verifies that the authorized Network works while the other is rejected server-side.
