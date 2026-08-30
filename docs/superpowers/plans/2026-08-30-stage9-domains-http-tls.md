# Stage 9 Domains, HTTP Endpoints and TLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Stage 9 by making TLS behavior deterministic from protocol mode, configuring Traefik ACME resolvers, reconciling safe certificate metadata, and actively removing obsolete RP-owned ingress routes.

**Architecture:** Keep Traefik as the ACME issuer/renewer and private-key owner. Resource Portal generates desired Traefik labels, stores only observed certificate metadata, and uses a focused Stage 9 reconciliation service for certificate state and route cleanup without introducing the generic Stage 16 Operations framework.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, Docker Swarm, Traefik labels/API, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-stage9-domains-http-tls-design.md`

## Global Constraints

- `HttpEndpoint.protocolMode` is the source of truth for TLS requirement.
- Traefik owns ACME issuance, renewal, private keys, and certificate presentation.
- Resource Portal must never persist or return certificate private keys or ACME secrets.
- Public Let's Encrypt issuance is not required in PR CI; configuration/runtime-path verification is required.
- Existing tenant isolation, `DomainInUse`, and `CustomRootDomainInUse` protections must remain intact.
- Route cleanup must target only deterministic RP-owned Traefik objects.

---

### Task 1: TLS semantics and Traefik ACME labels

**Files:**
- Modify: `packages/resourceportal-api/src/internal/traefik-routing.ts`
- Modify: `packages/resourceportal-api/src/internal/traefik-routing.spec.ts`
- Modify: `packages/resourceportal-api/src/internal/deployment-worker.service.ts`
- Modify: `packages/resourceportal-api/src/config/env.validation.ts`
- Modify: `packages/resourceportal-api/src/config/env.validation.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: existing `renderTraefikLabels(singleApp)` and deployment stack rendering.
- Produces: `protocolModeRequiresTls(protocolMode: string): boolean` and `renderTraefikLabels(singleApp, options?: { certResolver?: string })`.

- [ ] **Step 1: Write failing renderer tests**

Add assertions that `HTTPS`, `HTTP_AND_HTTPS`, and `HTTP_REDIRECT_TO_HTTPS` receive `traefik.http.routers.<router>.tls.certresolver=letsencrypt` when `{ certResolver: "letsencrypt" }` is supplied, while `HTTP` never receives a TLS/certresolver label. Add direct tests for `protocolModeRequiresTls()` returning `false` only for `HTTP`.

- [ ] **Step 2: Run renderer tests and verify failure**

Run: `npm --workspace packages/resourceportal-api test -- traefik-routing.spec.ts`
Expected: FAIL because the options argument/helper and certresolver labels do not exist.

- [ ] **Step 3: Implement renderer semantics**

Change the renderer signature to:

```ts
export function renderTraefikLabels(
  singleApp: TraefikSingleApp,
  options: { certResolver?: string } = {},
)
```

Add:

```ts
export function protocolModeRequiresTls(protocolMode: string) {
  return protocolMode !== "HTTP";
}
```

Pass `options.certResolver` into TLS router creation and emit `tls.certresolver` only when TLS is enabled and the resolver is non-empty.

- [ ] **Step 4: Add configuration validation tests**

Test `TRAEFIK_CERT_RESOLVER=letsencrypt` as valid and reject values outside `^[A-Za-z0-9_-]+$`, e.g. `"let's encrypt"`.

- [ ] **Step 5: Implement configuration wiring**

Validate optional `TRAEFIK_CERT_RESOLVER` and add it to `.env.example`. Inject/read it in `DeploymentWorkerService` and pass it to `renderTraefikLabels` during stack rendering.

- [ ] **Step 6: Run focused tests**

Run: `npm --workspace packages/resourceportal-api test -- traefik-routing.spec.ts env.validation.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

Commit message: `feat(stage9): configure traefik tls resolver`

---

### Task 2: Normalize Domain TLS state from endpoint protocol mode

**Files:**
- Modify: `packages/resourceportal-api/src/domains/domains.service.ts`
- Modify: `packages/resourceportal-api/src/domains/domains.service.spec.ts`
- Modify: `packages/resourceportal-api/src/domains/domains.view.ts`

**Interfaces:**
- Consumes: `protocolModeRequiresTls(protocolMode)` from Task 1 and existing Domain↔HttpEndpoint relations.
- Produces: Domain persistence/response state where `tlsEnabled` reflects the assigned endpoint's protocol mode instead of an independently contradictory user flag.

- [ ] **Step 1: Write failing service tests**

Cover these cases:

```text
assigned HTTP endpoint -> tlsEnabled=false
assigned HTTPS endpoint -> tlsEnabled=true
assigned HTTP_AND_HTTPS endpoint -> tlsEnabled=true
assigned HTTP_REDIRECT_TO_HTTPS endpoint -> tlsEnabled=true
detached Domain -> tlsEnabled=false and stale active certificate metadata is cleared/normalized
```

Also assert an incoming `tlsEnabled` value cannot override the protocol-derived result when a Domain is assigned.

- [ ] **Step 2: Run Domain tests and verify failure**

Run: `npm --workspace packages/resourceportal-api test -- domains.service.spec.ts`
Expected: FAIL because current create/update logic persists `dto.tlsEnabled` independently.

- [ ] **Step 3: Implement endpoint context protocol lookup**

Extend `findEndpointContextOrThrow()` to select `protocolMode`. Add a focused helper that returns the normalized Domain TLS fields from endpoint context:

```ts
private domainTlsState(protocolMode?: string) {
  const tlsEnabled = protocolMode ? protocolModeRequiresTls(protocolMode) : false;
  return {
    tlsEnabled,
    certificateStatus: tlsEnabled ? undefined : "Pending",
    certificateExpiresAt: tlsEnabled ? undefined : null,
  };
}
```

Use it on create, assign/reassign, detach, and relevant updates.

- [ ] **Step 4: Preserve backward-compatible API shape**

Keep existing response fields; do not add private certificate material or expose Traefik internals.

- [ ] **Step 5: Run Domain tests**

Run: `npm --workspace packages/resourceportal-api test -- domains.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

Commit message: `feat(stage9): derive domain tls requirement`

---

### Task 3: Certificate metadata observation and renewal reconciliation

**Files:**
- Create: `packages/resourceportal-api/src/internal/traefik-certificate-observer.service.ts`
- Create: `packages/resourceportal-api/src/internal/traefik-certificate-observer.service.spec.ts`
- Create: `packages/resourceportal-api/src/internal/domain-certificate-reconciler.service.ts`
- Create: `packages/resourceportal-api/src/internal/domain-certificate-reconciler.service.spec.ts`
- Modify: `packages/resourceportal-api/src/internal/internal.module.ts`
- Modify: `packages/resourceportal-api/src/config/env.validation.ts`
- Modify: `packages/resourceportal-api/src/config/env.validation.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces:

```ts
export type ObservedCertificate = {
  domains: string[];
  expiresAt: Date;
};

observeCertificates(): Promise<{
  certificates: ObservedCertificate[];
  error?: string;
}>;
```

and:

```ts
reconcileOnce(): Promise<{ checked: number; updated: number; failed: number }>;
```

- [ ] **Step 1: Write failing observer tests**

Use mocked `fetch` against an optional `TRAEFIK_API_URL` and verify safe parsing of certificate metadata without any persistence/logging of private-key fields. A missing URL returns a disabled/no-observation result rather than inventing certificate state.

- [ ] **Step 2: Implement the focused observer**

Read only safe certificate metadata from the configured Traefik API representation. Normalize hostnames/SANs and expiry timestamps. Treat malformed/unavailable responses as an observation error.

- [ ] **Step 3: Write failing reconciler tests**

Mock Prisma and observer to verify:

- TLS-required assigned Domain + matching unexpired cert -> `Active` and observed expiry,
- TLS-required Domain + no matching cert -> `Issuing` (or `Pending` when observation is disabled),
- expired/malformed observation -> `Error`,
- renewed cert with later expiry updates `certificateExpiresAt`,
- failure for one Domain does not prevent other updates.

- [ ] **Step 4: Implement reconciliation loop**

Create an injectable service with a public `reconcileOnce()` and an interval started by the internal worker runtime using `DOMAIN_CERTIFICATE_RECONCILE_INTERVAL_MS` (positive integer). Query only Domains assigned to endpoints whose protocol mode requires TLS and update only `tlsEnabled`, `certificateStatus`, `certificateExpiresAt`, `updatedBy="system"`, and timestamps already managed by Prisma.

- [ ] **Step 5: Register config and providers**

Validate `DOMAIN_CERTIFICATE_RECONCILE_INTERVAL_MS` and optional `TRAEFIK_API_URL`; add examples to `.env.example`; register services in `InternalModule`.

- [ ] **Step 6: Run focused tests**

Run: `npm --workspace packages/resourceportal-api test -- traefik-certificate-observer.service.spec.ts domain-certificate-reconciler.service.spec.ts env.validation.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

Commit message: `feat(stage9): reconcile certificate metadata`

---

### Task 4: Active route cleanup for detach/delete/protocol changes

**Files:**
- Create: `packages/resourceportal-api/src/internal/ingress-reconciler.service.ts`
- Create: `packages/resourceportal-api/src/internal/ingress-reconciler.service.spec.ts`
- Modify: `packages/resourceportal-api/src/domains/domains.service.ts`
- Modify: `packages/resourceportal-api/src/app-groups/app-groups.service.ts`
- Modify: `packages/resourceportal-api/src/internal/internal.module.ts`

**Interfaces:**
- Produces:

```ts
reconcileAppGroup(appGroupId: string): Promise<{
  success: boolean;
  message: string;
  details?: string;
}>;
```

- [ ] **Step 1: Write failing namespace-safety tests**

Verify the reconciler derives only deterministic RP stack/service names for the requested `appGroupId`, never accepts arbitrary router names from the API, and is idempotent when no deployed stack exists.

- [ ] **Step 2: Write mutation integration tests**

Mock the reconciler and verify it is invoked after successful desired-state mutation for Domain detach/reassign/delete and HttpEndpoint delete/protocol-mode change. Verify DB mutation remains committed if runtime cleanup returns a transient failure.

- [ ] **Step 3: Implement narrow ingress reconciliation**

Re-render/re-apply only the currently deployed AppGroup routing/service configuration using deterministic RP stack ownership, or trigger the existing stack apply path with the last deployed workload plus current routing desired state. Do not create a fake `AppGroupDeployment` success record and do not delete unrelated Swarm resources.

- [ ] **Step 4: Wire post-commit calls**

Call reconciliation only after DB transactions complete. Preserve `hasPendingChanges/runtimeDraftRevision` semantics so the next normal deployment still represents the full desired-state change.

- [ ] **Step 5: Run focused tests**

Run: `npm --workspace packages/resourceportal-api test -- ingress-reconciler.service.spec.ts domains.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

Commit message: `feat(stage9): reconcile obsolete ingress routes`

---

### Task 5: Stage 9 regression, documentation, and integration verification

**Files:**
- Modify: `packages/resourceportal-api/scripts/smoke-deploy.ts`
- Modify: `docs/wiki-compliance.md`
- Modify as required: `.github/workflows/swarm-integration.yml`

**Interfaces:**
- Consumes all Stage 9 behaviors from Tasks 1–4.
- Produces verified Stage 9 evidence suitable for the Wiki audit.

- [ ] **Step 1: Extend real-Swarm smoke assertions**

Assert generated/deployed service labels contain expected HTTP/HTTPS router labels and certresolver for TLS modes. Add an RP-owned route mutation/cleanup scenario that can be verified without contacting a public CA.

- [ ] **Step 2: Run full package tests and build**

Run:

```bash
npm --workspace packages/resourceportal-api test
npm --workspace packages/resourceportal-api run build
```

Expected: PASS.

- [ ] **Step 3: Run repository CI-equivalent checks available locally/CI**

Run root lint/test/build scripts from `package.json`; then rely on GitHub Actions for real Docker Swarm and federation workflows.

- [ ] **Step 4: Update compliance documentation**

Document exact Stage 9 responsibility boundary: protocol-derived TLS, Traefik certresolver, observed certificate metadata/renewal, active route cleanup, and the fact that PR CI does not claim real public-CA issuance.

- [ ] **Step 5: Commit**

Commit message: `docs(stage9): record domain tls lifecycle`

- [ ] **Step 6: Open PR and verify CI**

Open `feat/stage9-domains-tls` -> `main`, record exact head SHA, and verify CI, Real Docker Swarm Integration, and Live Federation Integration before merge.

- [ ] **Step 7: After merge update Wiki**

Update `Implementation Stages` and `Domain` from the verified merged implementation, including PR number, merge commit, final verified head, and precise integration-test scope.
