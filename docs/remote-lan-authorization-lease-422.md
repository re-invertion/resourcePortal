# Remote LAN Authorization Lease (#422) — security design and review checklist

Status: **candidate design; security review REQUIRED before any production release**.
This lease is *not* the address DHCP lease. Gate v3/older never receive offline
authorization. The feature requires both a server with lease support and a
physical Gate v4 installed by the explicitly authorized update path.

## Failure boundary and policy

A transient HTTPS failure (connection/TLS/timeout, 5xx, ambiguous ingress 404)
is not an authenticated authorization decision. It MUST NOT change WireGuard,
GRETAP, tenant firewall, managed Ethernet or the bridge for an already applied,
previously authorized attachment. It MUST NOT grant, provision, widen or renew
anything. The Gate marks its control plane Degraded and retries with bounded
backoff and jitter. The API can be unavailable even when the physical LAN,
encrypted tunnel and resident Gateway continue forwarding correctly.

Only a successful, authenticated Gate bearer request can renew authorization.
The response MUST echo a one-use 256-bit client nonce, bind the Gate and tenant
and issue **per-attachment** grants for the exact current revision, previously
proven Gate-side L2 state, and previously verified server-side policy. Unproven
new attachments and expanded revisions are not granted an offline lease. A
new/revised attachment still requires the existing fresh Gate/Node proofs.
The client validates the server response and scopes before applying it; an
empty authorized response, changed revision, tenant or Gate mismatch revokes.

**Candidate TTL: 600 seconds maximum**, from the last *accepted* server
renewal. This is a test proposal, **not approved** for production. It covers
the measured 443-second single outage plus one 30-second heartbeat interval,
while imposing a worst-case 10-minute revocation-latency exposure for a
completely isolated Gate. Security reviewers must explicitly approve the
default/max TTL, threat model and offline revocation tradeoff; reducing the
TTL may be necessary for specific tenants.

Lease deadlines on the Gate are based on CLOCK_BOOTTIME, never local wall time.
Use an independent watchdog to revoke at expiry even while curl hangs or the
main process sleeps. No lease is persisted for reuse across process or host
restart: startup always revokes any old RP-owned forwarding and requires fresh
authorization. The watchdog has an independent stop/restart policy. No
heartbeat error, 404, changed clock, replayed nonce, stale response, invalid
token or restart creates more time. Loss of watchdog safety requires fail-closed
revoke.

A signed/HTTPS-delivered authorization is not equivalent to instant remote
revocation across a network partition. An explicit, successfully delivered
authenticated removal/disable revokes immediately at the corresponding
enforcement point. In isolation it takes no more than the remaining lease TTL;
the server/Gateway must revoke locally when policy changes.

## Both ends / migration

Server must derive ongoing authorization from existing, immutable identity and
revision fields and persisted authenticated Gate/Node proof timestamps (avoid
schema changes that the current image-only rollback gate cannot certify).
Only *already Active* unchanged records qualify for continuity. The Swarm
gateway source sets must retain bounded expiry in the nft kernel even if
reconciler stops. DHCP address expiry remains an independent tighter bound.
Static IPv4 must also be bounded by authorization expiry. Stale telemetry must
not construct a fresh privilege or restart an existing Swarm network.

The upgrade of an already enrolled Gate must **not** re-enroll/rotate token,
private key, Gate ID, physical managed uplink, bridge ownership or tenants.
It should update agent scripts only, take controlled backups and explicitly
restart/re-authorize Gate service (short disruption during upgrade is possible).
Mixed-version Gate v3 retains old fail-closed behavior and is never granted a
lease. All existing L2 anti-spoofing, tenant isolation, source-MAC/IP, network,
handshake, and bounded evidence/provisioning rules remain mandatory.

## Acceptance gates

Unit/integration: mixed v3/v4, nonce replay, wrong Gate/tenant/revision,
malformed payload, timeout/404/502, recovery, expiry, crash/restart/clock
rollback, watchdog hung HTTP, simultaneous changes, explicit revoke, DHCP
expiration, static source and MAC/IP spoof rejection.

Disposable real Swarm: real host Gate + Gateway + app L2 traffic, bidirectional
ICMP/UDP/motion-click delivery during a 443 s API outage, beyond TTL, and
revoke; Gate upgrade/rollback preserving state. Official tests: full CI,
Fast Fix selection, WireGuard/Swarm dataplane security, both real rollback
certifications, security/code review, protected Merge Queue, exact-SHA signed
release, updater check. Do not test destructively on production RP/HA/Pi.

## Operator rollout (only after signed RP release)

The server upgrade and Gate-agent upgrade are separate operations. **First**
upgrade ResourcePortal using its supported-version UI. Existing v3 Gate
installations retain the prior immediate-revoke behavior until specifically
upgraded. The API advertises a supported Gate v4 capability; the in-place
Gate updater checks this authenticated capability and refuses an older API.

At a locally recoverable host, after confirming the release and relevant
tenant/Gate identity, run the supported installer in update mode:

~~~sh
curl -fsSL 'https://YOUR-RP-DOMAIN/api/networking/gates/install.sh' \
  | sudo bash -s -- --update
sudo systemctl status resourceportal-gate.service --no-pager
sudo python3 /usr/local/sbin/resourceportal-gate-authorization-lease.py --status
~~~

This is an *agent software* update, not a new enrollment. It preserves the
Gate ID, enrolled bearer token, WireGuard private key, managed uplink, host
identity and existing attachment definitions; no new token is accepted.
The updater does not automatically alter or re-apply the physical management
interface. The service restart invokes fail-closed cleanup and requires
a new authenticated heartbeat before restoring L2; a short upgrade-time
LAN interruption is expected. **Do not run it as a validation step on an
active production Raspberry Pi or Home Assistant.** Confirm a separate
host management recovery path before attempting any upgrade.

The updater creates a root-only backup under
/var/backups/resourceportal-gate-XXXXXX before replacing executables,
with fail-closed preflight for missing runtime dependencies or mismatched
API identity. To revert on a test host, restore the saved executable scripts
and service unit from that backup, reload systemd and restart the service
only after verifying the prior-version compatibility and that the previous
Gate agent version is still accepted by the RP API. Never rotate the
Gate private key or force re-enrollment as a rollback shortcut.

During an HTTPS outage the tenant Gate UI reports Degraded with the
remaining server-side authorization time. That does not prove bidirectional
traffic; use network-level observations for actual continuity. Do not
increase the local 600-second upper bound, fake heartbeat timestamps,
or edit the private lease file to make an outage appear resolved.

## Operational failure distinctions

- An HTTP 200 heartbeat with the correct challenge but an empty or
  incomplete lease never grants offline continuity. New provisioning may
  continue only while authenticated heartbeats keep arriving.
- HTTP 404 (ambiguous public ingress), 408/429, 5xx, TLS interruption or
  an unreachable socket are transport failures: preserve **existing**
  forwarding only while a previously accepted, identity-matched lease
  remains valid.
- Explicit API rejections 400/401/403/405/409/410/412/422, a successful
  changed/revoked config, a bad nonce or wrong-identity response revoke
  immediately. Local process restart and watchdog failure also revoke.
- Expiry is independent on the physical Gate and Swarm Gateway using
  kernel source-set timers. DHCP expiry remains a tighter bound.
  Old v3 Gates never inherit this grace period.
- Service/UI Active does not certify working connectivity.

### Live-only heartbeat scheduling

A successful authenticated Gate heartbeat without a complete offline grant
uses a separate 45-second authorization, not an offline lease. During this
mode the agent temporarily limits its next heartbeat delay to 10 seconds,
even when the configured normal interval is 30, 60 or 120 seconds (including
an in-place upgrade retaining the old interval). Transport failures are
**not** permitted to renew that short authorization, and the watchdog
revokes local forwarding if it expires. The persisted normal interval is
not changed by this safety adjustment.

### Topology-change watchdog race and full Gate capacity

An authenticated HTTPS 200 with a matching one-use nonce first replaces the
local offline authorization with a root-only 45-second transition scope.
The watchdog permits either the previously verified applied identity or the
exact new server-authorized identity while the LAN agent atomically replaces
its state file, then the agent installs a new offline or live-only grant.
Transition mode is not accepted by offline --valid, and expiry or failed
application revokes RP-owned forwarding. It does not extend old authority.
The two Gate Python consumers enforce the same 64,000-byte authorization
file limit, sufficient for all 64 allowed attachment grants (including
old/new transition scopes). A 65th attachment is rejected by the parser.

## 443-second disposable dataplane soak in Real Swarm CI

When a PR changes the Gate authorization helper, Gate LAN source enforcement or
installer, the reusable real-Swarm workflow additionally runs the isolated
Linux namespace smoke with RP_LAN_LONG_LEASE_SMOKE=1. It installs an actual
nft source rule for one already bound DHCP client with a 600-second deadline,
then **does not refresh the rule** for 443 real elapsed seconds. During that
period an HA-like client in its own application namespace sends 90 distinct
motion/click UDP events (45 of each) across two GRETAP ends over a live
WireGuard underlay. The customer LAN namespace returns a payload-correlated
acknowledgment for every event, proving bidirectional packet delivery.
The experiment verifies that neither WG nor GRETAP interface was recreated,
then waits past the original 600-second kernel deadline and requires real
IPv4 and event delivery to stop. A fresh source authorization must restore
connectivity. Regular PRs retain the quick smoke duration.

This **only validates a deliberately silent control plane at the real
kernel data-plane level**. It does *not* shut down the ResourcePortal API or
churn actual Traefik, does not run real Home Assistant integrations, and
does not constitute security sign-off on the 600-second revocation exposure.
The separate full API/Traefik fault-injection and HA-like end-to-end acceptance
scenario in issue #422 remains open until explicitly demonstrated. The
CI experiment is disposable and must never be run on the production
Raspberry Pi, Home Assistant or physical LAN.
