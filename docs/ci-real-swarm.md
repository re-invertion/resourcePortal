# Real Docker Swarm CI

Protected `Release Readiness` validates a release candidate, then launches applicable integration checks in parallel. The Merge Queue repeats those checks on the exact synthetic merge SHA. Post-merge `Installer-Gated Release` builds and publishes signed, immutable images.

## Independent Swarm groups

`.github/workflows/swarm-integration.yml` runs the existing `real-swarm` application/storage/deployment/browser/rollback harness separately from the `network-dataplane` WireGuard, Remote LAN, DHCP and Device VPN harness. They run on **different ephemeral runners and Docker daemons**.

The existing `scripts/fastfix-test-plan.mjs` classifier sets `swarm_smoke` and `vpn_smoke`. A milestone forces both. A network-impacting patch forces both. For an IAM-only or UI-only change selecting core Swarm but not VPN, the expensive dataplane job is skipped. The reusable `swarm` check fails if any required selected job fails; the branch-protected `Required release readiness` check still fails closed. No required test is bypassed.

For Gate lease/security changes, the original 443-second actual RP API outage and Traefik task churn remain mandatory; the test is not shortened or mocked. Full `workflow_dispatch` runs both groups.

## Caches and measurements

`actions/setup-node@v4` already caches npm downloads. Chromium in Swarm, real OIDC and federation now uses `actions/cache@v4` keyed by OS, architecture and `package-lock.json`; every run still executes `playwright install --with-deps chromium`. The protected final gate writes the ten slowest jobs and steps with actual GitHub Actions durations to `GITHUB_STEP_SUMMARY` (diagnostic-only).

The candidate still builds actual images and certifies RP+ZITADEL rollback, including the supported legacy v0.2.146 path. Merge Queue always checks its synthetic merge SHA. Post-merge release certification stays independent. Caches cannot replace those proof requirements.

## Running locally

The `npm run api:smoke:deploy` entrypoint requires a PostgreSQL `DATABASE_URL`, a real Swarm manager (`DOCKER_CONTEXT`), seeded `SMOKE_USER_ID`, writable volume/secret paths, and a reachable API at `RESOURCE_PORTAL_API_URL`.

```bash
npm run api:smoke:deploy
```
