# Privileged node-agent transport (#360)

The global Swarm node agent serves terminal operations and bounded GPU/capacity
probes. It has access to the local Docker socket; its API must never be routed
through unencrypted, publicly published, or attachable Docker networks.

## Network and authorization contract

- The production stack **adds** a separate `rp-terminal-secure` overlay with
  `driver_opts.encrypted=true` and `attachable=false`. The existing
  `rp-control` network is not modified, so the update does not attempt an
  in-place change to an already deployed Docker network.
- API and Worker join the encrypted overlay. The API uses the scoped DNS
  alias `worker-secure` for its authenticated Worker log/terminal API. The
  node agent joins **only** the encrypted overlay. No node-agent ports are
  published. Other control-plane services retain their existing networks.
- Before accepting privileged requests, the agent inspects the **effective**
  Docker network using its read-only socket and refuses startup unless the
  expected stack-scoped overlay has encryption and is not attachable. Worker
  terminal routes and GPU/capacity probes fail closed if they cannot verify
  that network. Merely declaring encryption in YAML is not trusted.
- Worker-to-node calls use HMAC-SHA256 per request, rather than sending the
  reusable `INTERNAL_WORKER_TOKEN` as a header. Signatures cover HTTP method,
  path, body digest (including tenant actor, service, action and command),
  target node IP, timestamp and a random single-use nonce. A node rejects
  signatures for another destination, stale requests (outside 30 seconds),
  incorrect bodies and replay. No individual API request can change the
  signed action without invalidating the MAC.
- Public API tenant RBAC remains the source of tenant authorization. A node
  accepts only signed requests from the trusted internal Worker; the
  node's signature verification is not a substitute for tenant RBAC.
- The API-facing GPU/capacity probe routers have **no Docker socket** and
  therefore cannot inspect the overlay directly. They send only bounded
  signed, empty-body probe requests, never the reusable Worker secret.
  The node agent itself refuses to listen if the encrypted overlay is absent.
  The privileged Worker terminal router performs its own effective-network
  verification before sending terminal data.

## Upgrade, verification and recovery

The existing `rp-control` and non-terminal services remain intact. The
standard installer/upgrade applies the new stack with the additional encrypted
network, rolls API/Worker/node-agent services, and verifies HTTPS health.
The existing image-only automatic rollback restores the previous Compose
specification if upgrade health fails; the new network can remain unused until
Swarm removes it. No schema migration or manual stack removal is required.

On a **disposable multi-node test Swarm**, verify the effective options and
both destination isolation and service connectivity:

```sh
docker network inspect resourceportal-control-plane_rp-terminal-secure \
  --format '{{json .Options}}'
docker service inspect resourceportal-control-plane_terminal-agent \
  --format '{{json .Spec.TaskTemplate.Networks}}'
docker service inspect resourceportal-control-plane_worker \
  --format '{{json .Spec.TaskTemplate.Networks}}'
```

The encrypted network must have `encrypted` set and the node-agent must
belong only to the dedicated network. Use synthetic test credentials when
checking that cross-node HTTP data is confidential. Never capture a production
secret or customer's shell output. Validate the actual automatic rollback
from the immediately preceding signed release using the mandatory CI gate
before merging.

If an administrator suspects prior underlay interception of the old bearer,
rotate the internal Worker credential through the supported installer rotation
flow. Rotating the secret invalidates existing internal sessions and requires
the services to converge; do not rotate directly through ad hoc Docker
commands. Existing production terminal sessions may disconnect during the
normal rolling update. Do not manually remove `rp-control`.
