# Managed TLS certificate recovery (#414)

## Incident and evidence (2026-11-08)

ResourcePortal observed `chat.p4tkry.pl` with DNS `Valid`, TLS enabled, certificate status `Error`, issuer `YR1` and no stored expiry. `DOMAIN_VERIFY` succeeded; a new AppGroup deployment failed at validation with `DomainUnavailable` and did not alter the running v33 workload. Later, the worker reported `Active` without toggling TLS and v35 deployed successfully, retaining data and bindings.

**Confirmed code-level mechanisms (v0.2.149):**

- `DOMAIN_VERIFY` verifies DNS and tenant ownership only. Its success is not ACME/Traefik certificate readiness.
- The certificate observer connected to the **public hostname** on port 443. Another TLS termination layer could present a valid certificate unrelated to managed Traefik.
- A transport/observation exception on an `Active` domain wrote `Error` and discarded the previously observed expiry, losing diagnostics; later successful reconciliation could recover.
- AppGroup validation rejected the **historical deployment snapshot** `certificateStatus=Error` without checking whether a later managed-ingress observation recovered.

These code defects were verified; the initiating event on November 8 (ACME authorization, rate limit, networking, worker timing or another transient cause) **cannot be established** from issue evidence alone. No authenticated historical Traefik ACME logs or correlated worker audit event were provided. An HTTP 200 response is not proof of a managed-ingress certificate.

## Repair architecture

Traefik remains the sole ACME issuer and holder of private certificates/keys. RP never deletes a valid ACME storage file to force issuance.

1. The worker's TLS observer targets its pinned **Swarm manager advertise IP on TCP/443**, a port published by the RP Traefik Swarm service, rather than resolving tenant-controlled/public DNS. It retains the domain as TLS SNI hostname, requires a trusted chain, checks SAN/wildcard coverage and expiry. No fallback to public DNS exists when the manager address is unavailable.
2. Worker periodic reconciliation updates `Pending/Issuing/Error/Active` using this managed-ingress evidence. A failed observation never changes `Error` back to `Issuing` and retains previously observed expiry/issuer as **historical** diagnostic metadata. `Error` still blocks a deployment without a fresh positive proof. Successful observation transitions the stored state to `Active` automatically.
3. Tenant-scoped GET `/api/tenants/:tenantId/domains/:domainId/certificate/diagnostics` returns separate DNS/TLS statuses, managed-ingress observation result, last check, sanitized cause, whether failure may be transient, and deployment blocker text. Ingress route publication is marked **NotVerified**; it cannot be inferred from TLS or DNS. Comprehensive publication/ownership UX belongs to #394.
4. Tenant-scoped POST `/api/tenants/:tenantId/domains/:domainId/certificate/reconcile` requires `domain.validate`, verifies tenant ownership and publishability, and queues `DOMAIN_CERTIFICATE_RECONCILE` through the existing worker. A per-actor/per-domain five-minute idempotency key limits duplicate requests and no automatic operation retry is scheduled. The worker reports a failed operation if observation failed.
5. AppGroup preflight reads current tenant-owned domain/DNS/ownership data rather than relying on an old snapshot. On an error, expired or unverified previously stored certificate, it performs a bounded authoritative managed-ingress TLS handshake; only a trustworthy, current certificate covering the hostname permits progress. Failed observation does not modify routes or workloads. HTTP 200 alone is never accepted.

**Boundaries:** No schema migration; no private-key API exposure; no Traefik/app restart; no TLS toggle; no third-party hostname SSRF via public DNS; ACME renewal/reissue remains Traefik's responsibility. The direct Swarm manager address must be reachable from the worker. If unavailable, fail closed with actionable error and inspect infrastructure.

## Operator diagnostic flow

1. In the tenant's Domain details, compare DNS status, managed TLS observation, cause and last check. Do not interpret `DOMAIN_VERIFY: Succeeded` as TLS success.
2. For `CertificateObservationFailed`, inspect worker connectivity to the configured `INSTALLER_SWARM_ADVERTISE_ADDR` on TCP/443 and Traefik availability; examine sanitized Traefik ACME logs from the operator side. Do not expose `acme.json` or private keys.
3. For `CertificateInvalid`, inspect the correct Traefik router, SNI/SAN coverage, the issuing resolver, ACME HTTP-01 challenge reachability on TCP/80 and certificate expiration. Do not delete `acme.json`.
4. Use **Retry TLS reconciliation** when the domain remains publishable and the issue has been resolved. The operation is queued, not an immediate certificate reissue; verify the operation outcome and refresh diagnostics.
5. Resume AppGroup deployment only after managed-ingress certificate evidence is valid. If preflight still fails, preserve the running AppGroup and investigate the detailed blocker.

## Verification and limitations

Unit and UI regression coverage includes stale/current TLS state combinations, invalid/mismatched/expired certificates, trusted observer failures, timeouts, absent SAN, worker manager routing, tenant isolation, explicit retry and repeated failed reconciliation. CI must also pass the full monorepo Fast Fix release gates and isolated real Swarm rollback certification.

Limitations: A publicly valid HTTPS edge does not prove the internal Traefik certificate. The shared ingress manager address proves a TLS endpoint on RP's published Swarm port but does not constitute cryptographic attestation of the Traefik process. Domain route publication is a separate concern in #394; DNS/routing diagnostics should be read independently. The original incident cannot be conclusively attributed to an ACME failure without historical logs.
