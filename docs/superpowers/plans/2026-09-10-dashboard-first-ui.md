# Dashboard-First Web Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a polished dashboard-first temporary ResourcePortal Web Console that reduces navigation and App Group complexity without changing backend contracts.

**Architecture:** Keep existing SSR/MPA routes and API calls, but add a reusable application shell, dashboard composition layer and App Group workspace hierarchy. Existing generic resource/forms remain the mutation engine; new components organize them around user tasks rather than endpoints.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Tailwind CSS v4, Vitest/Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-10-dashboard-first-ui-design.md`

## Global Constraints
- No backend/public API contract changes.
- No new runtime UI framework or dependency.
- Preserve SSR/MPA deep links, same-origin BFF, CSRF and session behavior.
- Preserve backend-authoritative RBAC; UI permission checks are UX only.
- Technical details remain accessible but secondary.
- Dashboard panels fail independently.

---

### Task 1: Dashboard-first application shell

**Files:**
- Create: `packages/resourceportal-web/src/components/shell.tsx`
- Create: `packages/resourceportal-web/src/components/shell.test.tsx`
- Modify: `packages/resourceportal-web/src/App.tsx`
- Modify: `packages/resourceportal-web/src/styles.css`

**Interfaces:**
- Produces: `AppShell({ user, route, children })`, grouped tenant/platform navigation based on existing routes.

- [ ] Write failing component tests asserting grouped labels `Overview`, `Applications`, `Storage & Networking`, `Billing`, `Access`, `Activity` and a visually separate `Platform Admin` section.
- [ ] Run `npm --workspace @resource-portal/web test -- src/components/shell.test.tsx` and confirm RED because `AppShell` does not exist.
- [ ] Implement `AppShell` with existing route URLs and logout behavior; replace the inline `Shell` in `App.tsx`.
- [ ] Add shell/sidebar/topbar/responsive Tailwind classes and active-state styling.
- [ ] Re-run shell tests and existing `src/App.test.tsx`; confirm GREEN.
- [ ] Commit `feat(web): add dashboard-first application shell`.

### Task 2: Tenant dashboard

**Files:**
- Create: `packages/resourceportal-web/src/pages/tenant-dashboard.tsx`
- Create: `packages/resourceportal-web/src/pages/tenant-dashboard.test.tsx`
- Modify: `packages/resourceportal-web/src/pages/tenant.tsx`
- Modify: `packages/resourceportal-web/src/styles.css`

**Interfaces:**
- Produces: `TenantDashboard({ tenantId })` using existing tenant, App Group, billing, volume and operations endpoints.
- Produces pure helpers for extracting items, summary counts and blocker callouts so derived behavior is testable.

- [ ] Write failing tests for summary cards, BillingSuspended human copy/link, App Group overview rows and local partial-error fallback.
- [ ] Run targeted dashboard tests and confirm RED.
- [ ] Implement parallel independent loads with local loading/error state per dataset.
- [ ] Implement metric cards, Needs attention callouts, application overview and quick actions using existing links.
- [ ] Wire tenant `overview` to `TenantDashboard`.
- [ ] Re-run dashboard and tenant usability tests; confirm GREEN.
- [ ] Commit `feat(web): add tenant control center dashboard`.

### Task 3: App Group workspace hierarchy

**Files:**
- Create: `packages/resourceportal-web/src/pages/app-group-workspace.tsx`
- Create: `packages/resourceportal-web/src/pages/app-group-workspace.test.tsx`
- Modify: `packages/resourceportal-web/src/pages/tenant.tsx`
- Modify: `packages/resourceportal-web/src/styles.css`

**Interfaces:**
- Produces: `AppGroupWorkspace` receiving root identifiers, permissions and reusable App Group child panels/workbenches.
- Consumes existing runtime/deploy/config endpoints unchanged.

- [ ] Write failing tests asserting operational header/statuses, task tabs/anchors, BillingSuspended actionable callout and Stack preview under Advanced details.
- [ ] Run targeted workspace test and confirm RED.
- [ ] Extract/reuse current App Group flows into the new hierarchy without changing endpoint payloads.
- [ ] Keep SingleApps, Variables, Configs, Secrets, deployment workbench and runtime controls functionally equivalent.
- [ ] Style sticky-ish operational header, tabs, grouped content and Advanced technical section.
- [ ] Run workspace plus existing tenant/resource/form tests; confirm GREEN.
- [ ] Commit `feat(web): reorganize app group workspace`.

### Task 4: Shared visual language and resource usability

**Files:**
- Create: `packages/resourceportal-web/src/components/ui.tsx`
- Create: `packages/resourceportal-web/src/components/ui.test.tsx`
- Modify: `packages/resourceportal-web/src/components/resource.tsx`
- Modify: `packages/resourceportal-web/src/components/forms.tsx`
- Modify: `packages/resourceportal-web/src/pages/platform.tsx`
- Modify: `packages/resourceportal-web/src/styles.css`

**Interfaces:**
- Produces reusable `StatusBadge`, `MetricCard`, `Callout`, `PageHeader`, `SectionNav` primitives.

- [ ] Write failing tests for semantic status tone/text and accessible section navigation/callout behavior.
- [ ] Confirm targeted RED.
- [ ] Implement primitives and migrate new dashboard/workspace plus high-traffic generic resource surfaces to them.
- [ ] Refine tables, empty states, forms, action hierarchy, platform page headers and Technical JSON styling without changing behavior.
- [ ] Run component/form/resource/platform-related tests; confirm GREEN.
- [ ] Commit `feat(web): polish console visual language`.

### Task 5: Verification, documentation and integration

**Files:**
- Modify: `docs/superpowers/specs/2026-09-10-dashboard-first-ui-design.md` only if implementation discovered a necessary clarification.
- Update Wiki `Web Console` and `Implementation Stages` after merge evidence exists.

**Interfaces:** none.

- [ ] Run `npm --workspace @resource-portal/web test`.
- [ ] Run `npm --workspace @resource-portal/web run lint`.
- [ ] Run `npm --workspace @resource-portal/web run build`.
- [ ] Run root-level relevant CI commands if defined and `git diff --check`.
- [ ] Inspect `git diff` for accidental backend/API changes, secrets and unrelated edits.
- [ ] Push branch, create PR, verify required checks and merge only when green.
- [ ] Update Wiki Stage 21 evidence/status accurately; do not mark Stage 21 COMPLETE unless all Definition-of-Done items are truly satisfied. Note dashboard-first work as Stage 22 partial if applicable.
