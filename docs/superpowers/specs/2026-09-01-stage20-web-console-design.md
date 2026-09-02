# Stage 20 Web Console Design

## Goal

Implement the first functional Resource Portal browser console in `packages/resourceportal-web` using React, TypeScript and Vite. Stage 20 is functional only: semantic HTML and minimal technical layout are allowed, but product styling/design-system work remains Stage 21.

## Source of truth

The web console consumes the existing public Resource Portal API. Backend RBAC, tenant isolation, quota, billing, capacity and lifecycle rules remain authoritative. The browser never talks directly to Docker Swarm, CephFS, ZITADEL management APIs, PostgreSQL, Prometheus, Loki or Tempo.

## Browser security model

Resource Portal API already owns the interactive OIDC Authorization Code + PKCE flow, server-side `PortalSession`, signed HttpOnly session cookie and double-submit CSRF protection. The web console therefore does not create a second token/session model.

Browser requests use same-origin `/api`, `credentials: same-origin`, and send `x-csrf-token` for unsafe methods using the browser-readable CSRF cookie issued by the backend. Access/refresh tokens are never stored in localStorage, sessionStorage or browser-readable cookies.

Development runs the Resource Portal Web server with Vite in middleware mode and keeps the Vite `/api` proxy. Production runs the built Web server as the same-origin boundary: `/api` is streamed to `RESOURCE_PORTAL_API_ORIGIN`, while document requests are rendered by the SSR entry. The Web server does not mint, decode or persist API tokens.

## SSR / MPA document model

Stage 20 is not a static SPA. Every direct browser document URL is handled by the Web server. The server parses the requested pathname, renders route-specific React HTML with the SSR entry and returns a real HTTP status. Unknown document routes return 404 instead of falling back to a universal `index.html` response.

The client hydrates server markup with `hydrateRoot`. Navigation is based on normal document links; there is no global `pushState`/`popstate` router responsible for making deep links work. This keeps direct refresh and copied URLs independent from client-router history state.

The initial SSR shell is route-aware and intentionally data-light. Session and tenant/resource data continue to bootstrap through the same-origin BFF/API contract after hydration. Server-side data preloading may be added where it materially improves a route, but it must preserve the same authorization/session boundary.

## Application structure

- `server.mjs` — development/production HTTP document server, production static assets and same-origin `/api` proxy.
- `src/entry-server.tsx` — React server render entry and HTTP status decision.
- `src/entry-client.tsx` — hydration entry.
- `src/api/` — browser-safe request transport, error envelope handling and domain client.
- `src/auth/` — session bootstrap and login/register/recover/logout helpers.
- `src/router/` — shared URL parser and route definitions; not a browser history router.
- `src/components/` — semantic primitives for states, forms, tables, JSON/details and one-time credentials.
- `src/pages/` — authenticated tenant and platform functional screens.
- `src/resources/` — declarative resource descriptors for CRUD/action screens.

Tenant context is always explicit in URLs under `/tenants/:tenantId/...`; platform administration lives under `/platform/...`.

## Functional screen strategy

Stage 20 has many public resource families. To keep behavior consistent and avoid a premature design system, the UI uses a small set of functional, schema-driven screens:

- collection/detail CRUD screens with per-resource field schemas,
- action controls for lifecycle/validation/retry/rotation,
- specialized pages for AppGroup/deployments, billing/quota, audit, operations and platform infrastructure,
- one-time credential panels held only in React memory and removable immediately.

Resource descriptors contain only presentation/request mapping. They do not reproduce backend authorization or business rules.

## Auth and tenant bootstrap

1. `/api/auth/me` establishes whether the browser session is valid after hydration.
2. Unauthenticated users can call provider discovery and navigate to backend login/register/recover endpoints.
3. After login, active tenants are fetched from `/api/tenants`.
4. Zero tenants shows an access/create-tenant screen; one or more active tenants produce normal document links. A later server-side single-tenant redirect is optional, not required for correctness.
5. A 401 clears in-memory application state and returns to login. A 403 renders access denied without pretending the resource does not exist.

## Error model

The transport preserves HTTP status, backend error code/message/details, `requestId` and `correlationId`. Shared error UI displays diagnostic identifiers when present and has distinct handling for 401, 403, 429 and maintenance 503.

## Tests

- Node/Vitest unit tests for browser transport, CSRF, error handling and route parsing.
- React component/integration tests for auth states, permission-aware controls, forms and one-time credential handling.
- SSR tests verify that a tenant deep link renders without browser globals and that unknown document routes map to HTTP 404.
- Stage 20 Dev production smoke starts the built Web server, requests a tenant deep link directly, verifies route-specific server HTML and verifies a real 404 without SPA fallback.
- Browser E2E smoke remains required for session bootstrap, tenant navigation and a representative AppGroup management flow using the real API environment in CI before Stage 20 can be marked complete.
- Static security regression asserts no access/refresh token persistence APIs are used by production web source.

## Build/deployment

The web package participates in root `build`, `lint` and `test`. The Web build emits `dist/client` and `dist/server`; production runs `server.mjs` with `NODE_ENV=production`. Development uses Vite middleware mode and the configured `/api` proxy. Production proxies only `/api` to Resource Portal API, serves built client assets directly, and SSR-renders every document route. There is no catch-all SPA fallback to `index.html`.
