# Stage 20 Web Console Design

## Goal

Implement the first functional Resource Portal browser console in `packages/resourceportal-web` using React, TypeScript and Vite. Stage 20 is functional only: semantic HTML and minimal technical layout are allowed, but product styling/design-system work remains Stage 21.

## Source of truth

The web console consumes the existing public Resource Portal API. Backend RBAC, tenant isolation, quota, billing, capacity and lifecycle rules remain authoritative. The browser never talks directly to Docker Swarm, CephFS, ZITADEL management APIs, PostgreSQL, Prometheus, Loki or Tempo.

## Browser security model

Resource Portal API already owns the interactive OIDC Authorization Code + PKCE flow, server-side `PortalSession`, signed HttpOnly session cookie and double-submit CSRF protection. The web console therefore does not create a second token/session model.

Browser requests use same-origin `/api`, `credentials: same-origin`, and send `x-csrf-token` for unsafe methods using the browser-readable CSRF cookie issued by the backend. Access/refresh tokens are never stored in localStorage, sessionStorage or browser-readable cookies.

A lightweight Vite development proxy routes `/api` to the configured API origin. Production deployment is a static SPA behind the same origin/reverse proxy as `/api`.

## Application structure

- `src/api/` — browser-safe request transport, error envelope handling and domain client.
- `src/auth/` — session bootstrap and login/register/recover/logout helpers.
- `src/router/` — URL parser/history router and route definitions.
- `src/components/` — semantic primitives for states, forms, tables, JSON/details and one-time credentials.
- `src/pages/` — authenticated tenant and platform functional screens.
- `src/resources/` — declarative resource descriptors for CRUD/action screens.

Tenant context is always explicit in URLs under `/tenants/:tenantId/...`; platform administration lives under `/platform/...`.

## Functional screen strategy

Stage 20 has many public resource families. To keep behavior consistent and avoid a premature design system, the UI uses a small set of functional, schema-driven screens:

- collection/detail CRUD screens with per-resource field schemas,
- action controls for lifecycle/validation/retry/rotation,
- specialized pages for AppGroup/deployments, billing/quota, audit export, operations and platform infrastructure,
- one-time credential panels held only in React memory and removable immediately.

Resource descriptors contain only presentation/request mapping. They do not reproduce backend authorization or business rules.

## Auth and tenant bootstrap

1. `/api/auth/me` establishes whether the browser session is valid.
2. Unauthenticated users can call provider discovery and navigate to backend login/register/recover endpoints.
3. After login, active tenants are fetched from `/api/tenants`.
4. Zero tenants shows an access/create-tenant screen, one tenant redirects into it, and multiple tenants show the tenant selector.
5. A 401 clears in-memory application state and returns to login. A 403 renders access denied without pretending the resource does not exist.

## Error model

The transport preserves HTTP status, backend error code/message/details, `requestId` and `correlationId`. Shared error UI displays diagnostic identifiers when present and has distinct handling for 401, 403, 429 and maintenance 503.

## Tests

- Node/Vitest unit tests for browser transport, CSRF, error handling and route parsing.
- React component/integration tests for auth states, permission-aware controls, forms and one-time credential handling.
- Browser E2E smoke for session bootstrap, tenant navigation and a representative AppGroup management flow using the real API environment in CI.
- Static security regression asserts no access/refresh token persistence APIs are used by production web source.

## Build/deployment

The web package participates in root `build`, `lint` and `test`. Vite emits a static artifact. Development uses a Vite `/api` proxy. Production requires same-origin routing where `/api` is forwarded to Resource Portal API and all non-API browser routes fall back to `index.html`.
