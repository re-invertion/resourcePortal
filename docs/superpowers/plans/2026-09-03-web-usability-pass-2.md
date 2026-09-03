# Web Usability Pass 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Preview Web Console usable without requiring users to reason about API payloads, raw IDs, or browser-native destructive confirmations.

**Architecture:** Extend the existing `ResourcePanel` and structured form primitives rather than introducing a new UI framework. Keep API contracts unchanged. Add task-oriented navigation and filtering in the Web layer only, and keep technical IDs/JSON available as secondary details.

**Tech Stack:** React, TypeScript, Tailwind preview styles, Formik/Yup runtime, Vitest/Testing Library, Playwright browser E2E.

**Spec:** Conversation-approved “Usability pass #2”: remove manual IDs where practical, `Patch` → `Edit`, clickable resources, search/status filtering, secondary action grouping, success feedback, actionable empty states, and an in-app destructive confirmation dialog.

## Global Constraints

- No backend/API/BFF/session/CSRF/RBAC/tenant-isolation/business-rule changes.
- Preserve one-time credential handling and technical JSON fallback behavior.
- Keep Stage 21 partial; do not implement Stage 22 dashboards/charts in this pass.
- Use existing dependencies; do not add a new component library.
- Exact final head must pass CI, Codespaces Preview Smoke, Live Federation Integration, and Real Docker Swarm Integration before merge.

---

### Task 1: Resource list usability

**Files:**
- Modify: `packages/resourceportal-web/src/components/resource.tsx`
- Modify: `packages/resourceportal-web/src/components/resource.test.tsx`
- Modify: `packages/resourceportal-web/index.html`

**Interfaces:**
- Consumes: existing `ResourcePanelProps`, `ReadableDataView`, `ResourceAction`.
- Produces: client-side `Search` input, optional status filter derived from list data, actionable empty state, `Edit` label, and compact secondary action menu.

- [ ] **Step 1: Write failing component tests** for search, status filtering, empty create CTA, and `Edit` wording.
- [ ] **Step 2: Run the Web test suite and confirm RED** because the controls/copy do not exist yet.
- [ ] **Step 3: Implement minimal filtering and action presentation** inside `ResourcePanel`; filtering is client-side and case-insensitive across scalar values.
- [ ] **Step 4: Add minimal preview styles** for list toolbar/action menu/empty state.
- [ ] **Step 5: Run tests and confirm GREEN.**

### Task 2: Safe destructive confirmation and success feedback

**Files:**
- Modify: `packages/resourceportal-web/src/components/forms.tsx`
- Modify: `packages/resourceportal-web/src/components/forms.test.tsx`
- Modify: `packages/resourceportal-web/src/components/resource.tsx`
- Modify: `packages/resourceportal-web/index.html`

**Interfaces:**
- Consumes: existing `ConfirmButton` and `ResourcePanel.mutate` flow.
- Produces: accessible in-app confirmation dialog and non-blocking success status message after successful mutations.

- [ ] **Step 1: Write failing tests** proving destructive actions render a dialog instead of calling `window.confirm`, cancellation does not mutate, confirmation does, and successful ResourcePanel mutation announces success.
- [ ] **Step 2: Run tests and confirm RED.**
- [ ] **Step 3: Implement the dialog and success state** without changing mutation APIs.
- [ ] **Step 4: Add minimal dialog/success styles.**
- [ ] **Step 5: Run tests and confirm GREEN.**

### Task 3: Remove manual IDs from common AppGroup flows

**Files:**
- Modify: `packages/resourceportal-web/src/pages/tenant.tsx`
- Modify/create relevant tenant page tests under `packages/resourceportal-web/src/pages/`
- Modify: `scripts/run-stage20-web-e2e.mjs`

**Interfaces:**
- Consumes: AppGroup `SingleApps` and deployment history payloads already fetched by `ResourcePanel`.
- Produces: row-level selection callbacks so users can choose a SingleApp or deployment by visible row/name rather than type an ID.

- [ ] **Step 1: Write failing tests** for row selection callbacks and AppGroup workbench selection behavior.
- [ ] **Step 2: Run tests and confirm RED.**
- [ ] **Step 3: Add optional `onSelect`/selection action to `ResourcePanel` and wire SingleApps/deployments to it.**
- [ ] **Step 4: Replace manual ID inputs with selected-resource context and clear/change controls.**
- [ ] **Step 5: Update Stage 20 E2E to select resources through the UI.**
- [ ] **Step 6: Run component/E2E verification and confirm GREEN.**

### Task 4: Final verification and integration

**Files:**
- Review all PR changes; no extra production scope.

**Interfaces:**
- Produces: one final exact head SHA eligible for merge.

- [ ] **Step 1: Review the complete diff for scope and security regressions.**
- [ ] **Step 2: Verify no unresolved review threads.**
- [ ] **Step 3: Require CI, Codespaces Preview Smoke, Live Federation Integration, and Real Docker Swarm Integration success on the exact same head SHA.**
- [ ] **Step 4: Mark PR ready, merge with `expected_head_sha`, and verify `main` points to the merge commit.**
- [ ] **Step 5: Update project documentation/Wiki if its connector is available in the active session.**
