# Production Installer ACME Resilience — Implementation Plan

**Goal:** prevent certificate-rate-limit, reinstall-state-loss, and concurrent-installer failures from reaching production.

## Implementation

- [x] Add a dedicated ACME module with production/staging resolver selection.
- [x] Use Let's Encrypt staging as the pre-production HTTP-01 gate.
- [x] Keep staging and production ACME storage isolated.
- [x] Request one combined auth + Web SAN certificate from both routers.
- [x] Preserve successful production ACME state in a root-only host reuse cache.
- [x] Preserve legacy active production ACME state before factory-reset storage destruction.
- [x] Restore reuse cache before Traefik ingress deployment without overwriting active state.
- [x] Verify preserved production certificate cryptographically and skip redundant staging issuance only when both configured hostnames are safely covered.
- [x] Validate production TLS and application readiness against local Traefik with SNI/hostname verification instead of hairpin NAT.
- [x] Classify terminal ACME errors and fail fast with sanitized actionable output.
- [x] Preserve Let's Encrypt retry-after timestamp for rate-limit failures.
- [x] Keep production TLS verification strict; permit insecure application health only in explicit staging E2E mode.
- [x] Add a host-wide installer process lock.
- [x] Preserve SSH reachability during factory-reset UFW cleanup before deleting ResourcePortal-owned firewall rules.
- [x] Expose safe ACME diagnostics without dumping ACME JSON/private keys.
- [x] Mark staging completion as not publicly trusted.

## Automated verification

- [x] Add ACME resilience regression tests.
- [x] Add concurrency-lock tests.
- [x] Add legacy factory-reset ACME preservation tests.
- [x] Add workflow contract tests.
- [x] Add dedicated `Production Installer Quality Gate` workflow.
- [x] Preserve existing CI/Swarm/Federation/Codespaces/Release/Web tests while adding installer gates.
- [ ] Run destructive full-install E2E on designated host `192.168.100.100` using staging ACME.
- [ ] Validate production-mode reinstall from preserved already-issued ACME state without new issuance.
- [ ] Run final full repo lint/test/build and installer verification on the exact merge candidate.
- [ ] Merge only after the above checks pass.
