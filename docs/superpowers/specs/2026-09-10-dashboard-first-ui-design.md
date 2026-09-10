# ResourcePortal Dashboard-First Web Console Design

## Status
Approved for implementation on 2026-09-10.

## Goal
Replace the endpoint-shaped preview UI with a polished, dashboard-first temporary Web Console that keeps the existing backend/API contracts but makes the large ResourcePortal feature set understandable and task-oriented.

## Product direction
The temporary visual direction is a hybrid cloud-console style: dark navigation sidebar, bright content surface, restrained neutral palette, strong status badges and clear action hierarchy. The visual treatment is temporary; the information architecture and component boundaries should remain reusable during a future redesign.

## Constraints
- Keep React 19, TypeScript, Vite SSR/MPA and Tailwind CSS v4.
- Do not introduce a component framework or new runtime dependency.
- Do not change public API contracts, BFF, CSRF, OIDC/session handling, tenant context, RBAC or backend business rules.
- Existing deep links must keep working.
- Technical JSON and low-frequency controls remain available but move behind Advanced/Technical details.
- Frontend permission filtering remains UX-only; backend remains authoritative.
- Dashboard panels must tolerate partial request failure instead of failing the whole page.

## Information architecture
Tenant navigation becomes six user-facing groups:
1. Overview
2. Applications
3. Storage & Networking
4. Billing
5. Access
6. Activity

Platform administration is visually separated and only useful to platform administrators. Existing route URLs remain stable; the shell groups existing destinations rather than requiring backend or route migrations.

Mapping:
- Overview -> tenant overview/dashboard
- Applications -> App Groups and contextual SingleApps, deployment/runtime/config surfaces
- Storage & Networking -> Volumes, Registries, Domains/HTTP routing
- Billing -> Billing, usage, transactions, quota, top-up
- Access -> Tenant administration and machine credentials
- Activity -> Operations and Audit
- Platform Admin -> overview, maintenance, infrastructure, IdPs, credentials, billing

## Tenant dashboard
The tenant overview becomes an orientation and decision screen. It answers:
- What is running?
- What needs attention?
- What can I do next?

It uses existing endpoints in parallel and displays:
- summary cards for applications/runtime, balance, storage and recent activity
- a prominent Needs attention area derived from existing backend state
- App Group list with human-readable status/health
- recent Operations/activity where available
- quick actions linking to existing create/manage surfaces

Partial failures render a local Unavailable state for the affected card/panel.

Blockers are translated into actionable copy. Example: BillingSuspended becomes “Applications are paused because your balance is empty” with a link to Billing. Technical blocker values remain available in details.

## App Group workspace
The current long App Group page becomes a workspace with an operational header and tab-like in-page sections:
- Overview
- Apps
- Config
- Networking
- Deployments
- Activity

The header shows name, runtime, health, drift, pending changes and last deployment metadata when available. Primary actions are Deploy changes, Start/Restart/Stop as applicable; destructive/rare actions live under secondary/advanced controls.

Overview contains runtime summary, blockers, pending changes and recent deployment information. Apps contains SingleApps. Config groups Variables, Configs, Secrets and application attachments. Networking surfaces HTTP endpoints/domain context that is already exposed by current App Group/SingleApp flows. Deployments contains deploy, history, details/events and rollback. Technical Stack preview is moved to Advanced.

No backend state is reverse-engineered beyond existing returned fields. UI does not fake a successful action when a backend operation fails.

## Component structure
Introduce focused UI primitives rather than expanding App.tsx/tenant.tsx indefinitely:
- app shell/navigation components
- dashboard data hooks/helpers and tenant dashboard component
- reusable status badge, metric card, alert/callout, page header and section tabs
- App Group workspace components/helpers

Existing ResourcePanel, structured forms, ReadableDataView and confirmation behavior remain reusable and receive styling improvements rather than being replaced wholesale.

## Responsive behavior
Desktop uses fixed/collapsible-feeling left navigation and a wide content area. Small screens stack the header/content and expose navigation as a compact wrapping/top surface without hiding functionality. Tables retain horizontal scroll as fallback.

## Accessibility
Preserve semantic navigation, headings, forms, labels and focus-visible styles. Status is conveyed by text as well as color. Destructive confirmations remain accessible. Dynamic success/error states keep ARIA status/alert semantics.

## Testing
Add component/unit coverage for:
- grouped shell navigation and active route state
- dashboard derived summaries and blocker copy
- partial dashboard failure behavior
- App Group workspace information hierarchy and technical-details placement
- existing route/deep-link behavior

Run full web test, lint/typecheck and production build before merge. Keep existing security/storage tests green.
