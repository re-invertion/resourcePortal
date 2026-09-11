# ResourcePortal Production Installer — ACME and Reinstall Resilience

## Incident being prevented

Repeated clean installs/factory resets can delete Traefik ACME state and cause the next install to request a new public certificate for the same hostnames. Let's Encrypt production limits can then block an otherwise healthy installation. A second installer process can compound the problem by replaying the same mutating phases concurrently.

## Required behavior

1. Production remains the default TLS mode.
2. Before any production issuance, the installer validates DNS and proves HTTP-01 reachability using the Let's Encrypt staging CA.
3. Staging and production ACME state use separate files.
4. ZITADEL and Web request one canonical combined certificate: auth hostname as main, Web hostname as SAN.
5. Successful production ACME state is mirrored to `/var/lib/resourceportal/acme-cache/acme.json` with root-only permissions.
6. Factory reset preserves valid legacy/current production ACME state to that cache before storage destruction. It never preserves disposable staging state.
7. Reinstall restores cached production ACME state before Traefik starts, but never overwrites a non-empty active state file. When that preserved certificate is cryptographically valid, covers both configured hostnames, and is not near expiry, the reinstall skips a redundant staging order because no new production issuance is required.
8. Corrupt cache is quarantined and must not block clean issuance.
9. Production HTTPS validation never uses `--insecure`. Certificate and application readiness are checked against local Traefik with `curl --resolve <hostname>:443:127.0.0.1`, preserving SNI/hostname validation while avoiding false positives through hairpin NAT or another ingress node. Explicit staging E2E may use `--insecure` only for application health after staging certificate issuance has been proven from ACME state.
10. Terminal ACME failures are classified from Traefik logs and fail immediately. Rate-limit output includes the CA-provided retry-after timestamp.
11. ACME diagnostics expose only environment/presence/domain coverage; they never print `acme.json`, account keys, certificate keys, or secret values.
12. A host-wide installer lock prevents concurrent install/reset/repair processes.
13. `--acme-environment staging` is test-only, persisted for resume, and completion output clearly says the certificate is not publicly trusted.

## Test requirements

The installer regression suite must cover resolver selection, corrupt/missing cache, restore precedence, root-only permissions, legacy factory-reset preservation, rate-limit fail-fast behavior, retry-after extraction, strict local production TLS/SNI validation, staging E2E behavior, combined SAN rendering, valid-certificate reinstall reuse without redundant staging issuance, final certificate ordering, cache persistence, host-wide concurrency locking, workflow coverage, and staging/production completion labels.

GitHub workflows keep their existing application/integration responsibilities and additionally execute `npm run test:installer`. A dedicated `Production Installer Quality Gate` runs shell syntax validation, ShellCheck, the complete installer suite, and the focused ACME resilience suite.

Real destructive installer E2E is performed only on a designated disposable host. E2E uses staging ACME unless it is explicitly validating reuse of already-issued production state; it must not consume production certificate issuance merely to test installation mechanics.
