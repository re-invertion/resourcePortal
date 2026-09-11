# Azure-like Web Console Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the Azure-like ResourcePortal UI foundation and prove it end-to-end on the AppGroups inventory/detail/create flow without regressing current production-preview functionality.

**Architecture:** Keep React/Vite and existing API contracts. Introduce focused presentation primitives and explicit resource view models instead of extending generic JSON-oriented rendering. Phase 1 establishes the shell, icon boundary, command-bar behavior, curated AppGroups inventory/detail UI, and the typed AppGroup create wizard; later phases migrate the remaining resource families to the same primitives.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Tailwind CSS 4, Vitest, Testing Library, Playwright browser E2E.

**Spec:** `docs/superpowers/specs/2026-09-11-azure-like-web-console-redesign.md`

## Global Constraints

- ResourcePortal remains ResourcePortal-branded; do not copy Microsoft logos, names or proprietary visual assets.
- Normal authenticated routes must not render `Technical JSON`, raw `<pre>` payloads, arbitrary object trees or `JSON.stringify` as user-facing data.
- Command bars must remain one stable row; overflow actions open in overlays/popovers and never expand the header layout.
- Resource inventories define columns explicitly by resource type; do not derive columns from arbitrary backend keys.
- Creation forms render product concepts, not DTO/object editors.
- Unknown backend fields are ignored until intentionally mapped.
- Existing backend API contracts remain unchanged in this phase.
- Do not add fake controls for unsupported search, notifications or actions.
- Desktop is the primary operations layout; medium/small layouts use collapse/overflow instead of shrinking or wrapping controls unpredictably.
- All behavior changes follow TDD: test first, observe expected failure, implement minimally, verify green.

---

## File Structure

Phase 1 should converge on these boundaries:

- `packages/resourceportal-web/src/components/icons.tsx` — semantic ResourcePortal icon API. Product code asks for `tenant`, `appGroup`, `application`, `volume`, `refresh`, `more`, etc.; concrete icon implementation stays isolated here.
- `packages/resourceportal-web/src/components/command-bar.tsx` — stable one-line command bar and anchored overflow menu.
- `packages/resourceportal-web/src/components/properties.tsx` — curated property/value rendering primitives without recursive object fallback.
- `packages/resourceportal-web/src/components/resource-table.tsx` — explicit-column inventory table with row actions.
- `packages/resourceportal-web/src/components/shell.tsx` — Azure-like navigation chrome, semantic icons and stable tenant/platform context.
- `packages/resourceportal-web/src/components/ui.tsx` — common status/callout/page-heading primitives; no resource-specific API knowledge.
- `packages/resourceportal-web/src/pages/app-groups.tsx` — AppGroups inventory and AppGroup presentation adapters/view model.
- `packages/resourceportal-web/src/pages/app-group-create.tsx` — typed AppGroup creation flow and review view.
- `packages/resourceportal-web/src/pages/app-group-workspace.tsx` — AppGroup detail composition using the shared header/command/property primitives.
- `packages/resourceportal-web/src/pages/tenant.tsx` — routing/composition only for the migrated AppGroups slice; legacy panels remain temporarily for non-migrated sections.
- `packages/resourceportal-web/src/styles.css` — shell/table/command-bar/form responsive styles and tokens.
- `packages/resourceportal-web/src/**/*.test.tsx` and `scripts/run-stage20-web-e2e.mjs` — regression and browser behavior coverage.

---

### Task 1: Freeze the phase-1 UX contract in tests

**Files:**
- Modify: `packages/resourceportal-web/src/App.test.tsx`
- Create: `packages/resourceportal-web/src/components/command-bar.test.tsx`
- Create: `packages/resourceportal-web/src/pages/app-groups.test.tsx`
- Modify: `packages/resourceportal-web/production-ui.test.mjs`
- Modify: `scripts/run-stage20-web-e2e.mjs`

**Interfaces:**
- Consumes: current `App`, current tenant routing, current AppGroups API endpoints.
- Produces: executable assertions defining the visible shell, stable command-bar overflow, no raw-data fallback, curated AppGroups inventory, and guided create behavior.

- [ ] **Step 1: Add a failing shell/navigation test**

Add assertions that authenticated tenant UI exposes semantic navigation labels with icons hidden from assistive text and that the content area has a breadcrumb region. The test must require a real semantic icon marker such as `data-rp-icon="app-group"` rather than generic navigation dots.

```tsx
expect(screen.getByRole("navigation", { name: "Workspace" })).toBeInTheDocument();
expect(screen.getByRole("link", { name: "App Groups" }).querySelector('[data-rp-icon="app-group"]')).not.toBeNull();
expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
```

- [ ] **Step 2: Add a failing command-bar behavior test**

Create `command-bar.test.tsx` with a narrow-width/explicit overflow scenario. Assert that `More actions` opens a menu and does not insert extra command buttons into the command-bar container.

```tsx
render(<CommandBar actions={[
  { id: "start", label: "Start", onClick: vi.fn() },
  { id: "restart", label: "Restart", onClick: vi.fn(), overflow: true },
]} />);

const bar = screen.getByRole("toolbar", { name: "Resource actions" });
expect(within(bar).getByRole("button", { name: "Start" })).toBeInTheDocument();
fireEvent.click(within(bar).getByRole("button", { name: "More actions" }));
expect(screen.getByRole("menu")).toBeInTheDocument();
expect(screen.getByRole("menuitem", { name: "Restart" })).toBeInTheDocument();
expect(within(bar).queryByRole("button", { name: "Restart" })).toBeNull();
```

- [ ] **Step 3: Add failing no-raw-data assertions**

Update production UI tests to reject the known transitional user-facing patterns.

```js
assert.doesNotMatch(resourceSource, /Technical JSON/);
assert.doesNotMatch(createSource, /<code>\{JSON\.stringify\(value\)\}<\/code>/);
assert.doesNotMatch(createSource, /JSON\.stringify\(entry\)/);
```

Scope these checks to rendered UI source, not implementation-only cloning/comparison code.

- [ ] **Step 4: Add a failing AppGroups inventory test**

Mock `/api/tenants/:id/app-groups` with fields including an intentionally unknown backend property. Require only curated columns and ensure the unknown property is absent.

```tsx
expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
expect(screen.getByRole("columnheader", { name: "Health" })).toBeInTheDocument();
expect(screen.queryByText("internalSchedulerHint")).toBeNull();
expect(screen.getByRole("link", { name: "shop-production" })).toHaveAttribute(
  "href",
  "/tenants/tenant-1/app-groups/group-1",
);
```

- [ ] **Step 5: Extend browser E2E for the intended create UX**

Require the AppGroups route to expose `Create AppGroup`, a guided `Basics` step, `Review + create`, and a final `Create AppGroup` action. Require that opening overflow does not change the toolbar height.

- [ ] **Step 6: Run/observe RED**

Run:

```bash
npm --workspace @resource-portal/web test
node packages/resourceportal-web/production-ui.test.mjs
```

Expected: failures because semantic icon markers, `CommandBar`, curated AppGroups table and zero-raw-data rules are not implemented yet.

- [ ] **Step 7: Commit the failing tests**

```bash
git add packages/resourceportal-web/src/App.test.tsx \
  packages/resourceportal-web/src/components/command-bar.test.tsx \
  packages/resourceportal-web/src/pages/app-groups.test.tsx \
  packages/resourceportal-web/production-ui.test.mjs \
  scripts/run-stage20-web-e2e.mjs
git commit -m "test(web): define Azure-like console phase 1 contract"
```

---

### Task 2: Add semantic icons and stable shell chrome

**Files:**
- Create: `packages/resourceportal-web/src/components/icons.tsx`
- Modify: `packages/resourceportal-web/src/components/shell.tsx`
- Modify: `packages/resourceportal-web/src/components/ui.tsx`
- Modify: `packages/resourceportal-web/src/styles.css`
- Modify: `packages/resourceportal-web/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `ResourceIcon`, `ResourceIconName`, `Breadcrumbs`, updated `AppShell` chrome.

Define:

```ts
export type ResourceIconName =
  | "home" | "tenant" | "app-group" | "application" | "volume"
  | "registry" | "domain" | "billing" | "access" | "credential"
  | "operation" | "audit" | "platform" | "refresh" | "more"
  | "start" | "stop" | "restart" | "delete" | "add";

export function ResourceIcon(props: {
  name: ResourceIconName;
  filled?: boolean;
  className?: string;
}): JSX.Element;
```

Use `@fluentui/react-icons` as the only external icon source. Product components import only `ResourceIcon`, not package-specific icon symbols.

Define `Breadcrumbs` in `ui.tsx`:

```ts
export type BreadcrumbItem = { label: string; href?: string };
export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }): JSX.Element;
```

- [ ] **Step 1: Add the icon dependency with lockfile update**

Run:

```bash
npm install --workspace @resource-portal/web @fluentui/react-icons
```

Do not add the full Fluent component framework.

- [ ] **Step 2: Implement the semantic icon map**

Map every `ResourceIconName` to one regular Fluent icon and use filled variants only for active navigation where available. Render `aria-hidden="true"` and `data-rp-icon={name}`.

- [ ] **Step 3: Replace navigation dots and bespoke shell marks**

Update tenant/platform navigation to accept an icon per item and render `ResourceIcon`. Keep visible labels. Add selected-state styling without changing link dimensions.

- [ ] **Step 4: Add breadcrumbs to authenticated shell content**

Derive only hierarchy already available from the route at shell level. Resource-name enrichment remains page-specific; IDs are acceptable temporary fallback according to the spec.

- [ ] **Step 5: Implement compact shell styles**

Keep navigation width stable in the 224–240 px range on desktop. Use one-line top bar and prevent navigation labels/actions from changing dimensions on selection.

- [ ] **Step 6: Run tests and build**

```bash
npm --workspace @resource-portal/web test
npm --workspace @resource-portal/web run build
node packages/resourceportal-web/production-ui.test.mjs
```

Expected: shell/icon tests pass; AppGroups/command-bar tests may remain red until their tasks.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json packages/resourceportal-web
git commit -m "feat(web): add Azure-like shell icon system"
```

---

### Task 3: Implement stable command bars and curated presentation primitives

**Files:**
- Create: `packages/resourceportal-web/src/components/command-bar.tsx`
- Create: `packages/resourceportal-web/src/components/properties.tsx`
- Create: `packages/resourceportal-web/src/components/resource-table.tsx`
- Create: `packages/resourceportal-web/src/components/resource-table.test.tsx`
- Modify: `packages/resourceportal-web/src/components/ui.tsx`
- Modify: `packages/resourceportal-web/src/styles.css`

**Interfaces:**

```ts
export type CommandAction = {
  id: string;
  label: string;
  icon?: ResourceIconName;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  destructive?: boolean;
  overflow?: boolean;
};

export function CommandBar(props: {
  actions: CommandAction[];
  ariaLabel?: string;
}): JSX.Element;
```

```ts
export type ResourceColumn<T> = {
  id: string;
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
};

export function ResourceTable<T extends { id: string }>(props: {
  rows: T[];
  columns: ResourceColumn<T>[];
  getHref?: (row: T) => string | undefined;
  rowActions?: (row: T) => CommandAction[];
  emptyTitle: string;
  emptyDescription: string;
  emptyAction?: ReactNode;
}): JSX.Element;
```

- [ ] **Step 1: Make command-bar test green**

Implement fixed inline actions plus an absolutely/portal-positioned menu. Menu interaction may use local React state; click-outside/Escape support must be covered by tests.

- [ ] **Step 2: Add ResourceTable tests first**

Assert explicit columns only, accessible table headers, clickable resource name supplied by the caller, and row overflow menu.

- [ ] **Step 3: Implement ResourceTable minimally**

Do not inspect arbitrary object keys inside `ResourceTable`.

- [ ] **Step 4: Add curated property primitives**

Implement `PropertyList`, `CopyableValue`, `TagList`, `DateTimeValue`, `SizeValue` and reuse shared `StatusBadge`. None of these recurse through unknown objects.

- [ ] **Step 5: Verify**

```bash
npm --workspace @resource-portal/web test -- command-bar resource-table
npm --workspace @resource-portal/web run build
```

- [ ] **Step 6: Commit**

```bash
git add packages/resourceportal-web/src/components packages/resourceportal-web/src/styles.css
git commit -m "feat(web): add stable resource command and data primitives"
```

---

### Task 4: Replace AppGroups generic inventory with an explicit view model

**Files:**
- Create: `packages/resourceportal-web/src/pages/app-groups.tsx`
- Modify: `packages/resourceportal-web/src/pages/tenant.tsx`
- Modify: `packages/resourceportal-web/src/styles.css`
- Test: `packages/resourceportal-web/src/pages/app-groups.test.tsx`

**Interfaces:**

```ts
export type AppGroupListItem = {
  id: string;
  name: string;
  runtimeState: string;
  effectiveRuntimeState: string;
  health: string;
  driftStatus: string;
  hasPendingChanges: boolean;
  currentDeploymentVersion?: number;
  updatedAt?: string;
};

export function toAppGroupListItem(value: unknown): AppGroupListItem | undefined;
export function AppGroupsPage(props: {
  tenantId: string;
  permissions?: string[];
}): JSX.Element;
```

- [ ] **Step 1: Verify the AppGroups inventory test is red**

Run the specific test and confirm the failure is due to missing `AppGroupsPage`/curated columns.

- [ ] **Step 2: Implement defensive AppGroup mapping**

Map only fields needed by the view. Unknown backend properties are deliberately ignored.

- [ ] **Step 3: Build explicit columns**

Columns: Name, Status, Health, Drift, Deployment, Changes. Use semantic icons and status badges. Resource name is the primary detail link.

- [ ] **Step 4: Add page header and stable command bar**

Visible actions: `Create AppGroup`, `Refresh`. Do not expose generic panel controls.

- [ ] **Step 5: Wire tenant routing**

For `section === "app-groups" && !resourceId`, render `AppGroupsPage`; keep detail routing to `AppGroupWorkspace`.

- [ ] **Step 6: Verify**

```bash
npm --workspace @resource-portal/web test -- app-groups
npm --workspace @resource-portal/web run build
```

- [ ] **Step 7: Commit**

```bash
git add packages/resourceportal-web/src/pages/app-groups.tsx \
  packages/resourceportal-web/src/pages/app-groups.test.tsx \
  packages/resourceportal-web/src/pages/tenant.tsx \
  packages/resourceportal-web/src/styles.css
git commit -m "feat(web): add curated AppGroups inventory"
```

---

### Task 5: Build the typed AppGroup create wizard and eliminate raw review rendering

**Files:**
- Create: `packages/resourceportal-web/src/pages/app-group-create.tsx`
- Create: `packages/resourceportal-web/src/pages/app-group-create.test.tsx`
- Modify: `packages/resourceportal-web/src/pages/app-groups.tsx`
- Modify: `packages/resourceportal-web/src/components/create-resource.tsx`
- Modify: `packages/resourceportal-web/src/components/resource.tsx`
- Modify: `packages/resourceportal-web/src/styles.css`
- Modify: `packages/resourceportal-web/production-ui.test.mjs`

**Interfaces:**

```ts
export type AppGroupCreateDraft = {
  name: string;
  runtimeState?: string;
};

export function AppGroupCreateWizard(props: {
  tenantId: string;
  onCancel: () => void;
  onCreated: (id?: string) => void | Promise<void>;
}): JSX.Element;
```

- [ ] **Step 1: Write failing wizard tests**

Require `Basics` and `Review + create`, human descriptions, no raw object editor, and exactly one mutating request after final create.

- [ ] **Step 2: Implement Basics step**

Use explicit controlled fields for `name` and real AppGroup creation fields from `appGroupForm`. Do not render generic field/type editors.

- [ ] **Step 3: Implement Review + create**

Render a labelled review section. Arrays/objects, if introduced by current DTO, must use named rows/chips—not serialization.

- [ ] **Step 4: Connect `POST /api/tenants/:tenantId/app-groups`**

The Review action remains non-mutating. Only final `Create AppGroup` performs POST.

- [ ] **Step 5: Remove user-facing raw fallbacks from shared transitional components**

Set `ReadableDataView` to never render `Technical JSON`. Remove `JSON.stringify` from `ReviewValue` in `create-resource.tsx`; structured unknown values render `Not available in this view` until explicitly mapped. Keep implementation-only `JSON.stringify` in cloning/comparison logic.

- [ ] **Step 6: Verify zero-raw-data tests**

```bash
npm --workspace @resource-portal/web test
node packages/resourceportal-web/production-ui.test.mjs
npm --workspace @resource-portal/web run build
```

- [ ] **Step 7: Commit**

```bash
git add packages/resourceportal-web/src/pages/app-group-create.tsx \
  packages/resourceportal-web/src/pages/app-group-create.test.tsx \
  packages/resourceportal-web/src/pages/app-groups.tsx \
  packages/resourceportal-web/src/components/create-resource.tsx \
  packages/resourceportal-web/src/components/resource.tsx \
  packages/resourceportal-web/src/styles.css \
  packages/resourceportal-web/production-ui.test.mjs
git commit -m "feat(web): add typed AppGroup provisioning wizard"
```

---

### Task 6: Convert AppGroup detail to Azure-like resource header and command bar

**Files:**
- Modify: `packages/resourceportal-web/src/pages/app-group-workspace.tsx`
- Create: `packages/resourceportal-web/src/pages/app-group-workspace.test.tsx` or extend the existing AppGroup workspace test if present
- Modify: `packages/resourceportal-web/src/styles.css`

**Interfaces:**
- Consumes: `CommandBar`, `Breadcrumbs`, `PropertyList`, `StatusBadge`, `ResourceIcon`.
- Produces: canonical resource-detail composition for later Volume/Application/etc migrations.

- [ ] **Step 1: Add failing detail tests**

Require semantic icon, resource type/name/status, breadcrumb navigation, command bar with Start/Stop/Restart and overflow, and `Essentials` properties.

- [ ] **Step 2: Replace the current custom header**

Render a `ResourceHeader`/equivalent composition with icon, name, App Group type and status badges. Keep current blocker logic intact.

- [ ] **Step 3: Move runtime actions into CommandBar**

Start/Stop/Restart stay visible according to runtime state; secondary/technical actions move to overflow. Clicking `More actions` must not change header height.

- [ ] **Step 4: Replace the overview metric boxes with Essentials**

Use `PropertyList` for Desired state, Effective state, Health, Current deployment and Pending changes. Keep actionable warning callouts outside the property grid.

- [ ] **Step 5: Remove `Advanced & technical details` raw rendering from this migrated detail page**

Replace it with intentionally named links/sections only. Existing backend stack preview/detail may remain accessible only after they receive a curated view; do not dump it recursively in this route.

- [ ] **Step 6: Verify**

```bash
npm --workspace @resource-portal/web test -- app-group
npm --workspace @resource-portal/web run build
```

- [ ] **Step 7: Commit**

```bash
git add packages/resourceportal-web/src/pages/app-group-workspace.tsx \
  packages/resourceportal-web/src/pages/app-group-workspace.test.tsx \
  packages/resourceportal-web/src/styles.css
git commit -m "feat(web): redesign AppGroup resource workspace"
```

---

### Task 7: Browser E2E, responsive stability and phase-1 production gate

**Files:**
- Modify: `scripts/run-stage20-web-e2e.mjs`
- Modify: `scripts/run-stage20-real-swarm-web-e2e.mjs`
- Modify: `packages/resourceportal-web/production-ui.test.mjs`
- Modify: `packages/resourceportal-web/src/styles.css` only for issues reproduced by E2E

**Interfaces:**
- Produces: production gate proving the canonical migrated flow.

- [ ] **Step 1: Run browser E2E against a clean preview build**

```bash
node scripts/run-stage20-web-e2e.mjs
```

Verify tenant selection -> AppGroups inventory -> create wizard -> review -> create -> detail -> runtime command interaction.

- [ ] **Step 2: Add explicit layout assertions**

At desktop and narrow viewport widths, record command-bar bounding box before and after opening overflow. Assert height is unchanged and menu is visually separate from the bar.

- [ ] **Step 3: Run static production checks**

```bash
node packages/resourceportal-web/production-ui.test.mjs
```

Require no `Technical JSON` and no rendered `JSON.stringify` fallback in migrated product views.

- [ ] **Step 4: Run full Web verification**

```bash
npm --workspace @resource-portal/web test
npm --workspace @resource-portal/web run lint
npm --workspace @resource-portal/web run build
node packages/resourceportal-web/production-ui.test.mjs
node scripts/run-stage20-web-e2e.mjs
```

Expected: all commands exit 0.

- [ ] **Step 5: Run CI/integration workflows for the exact branch head**

Require green CI and Codespaces Preview Smoke. Investigate any Real Docker Swarm failure against the exact changed behavior rather than assuming it is environmental.

- [ ] **Step 6: Final phase-1 commit if E2E required fixes**

```bash
git add packages/resourceportal-web scripts
git commit -m "test(web): verify Azure-like AppGroup vertical slice"
```

---

## Phase-1 Completion Criteria

Phase 1 is complete only when all of the following are true:

1. Authenticated tenant navigation uses semantic icons and stable Azure-like chrome.
2. AppGroups inventory is explicit and does not derive arbitrary columns from API fields.
3. AppGroup create uses an explicit guided wizard; review is non-mutating and contains no raw JSON representation.
4. AppGroup detail uses a stable resource header, breadcrumbs, Essentials, and one-line command bar/overflow pattern.
5. Opening `More actions` does not change command-bar/header dimensions.
6. `Technical JSON` is removed from normal rendered product views.
7. Unit tests, production UI static checks, Web build and browser E2E pass for the exact final SHA.
8. The resulting primitives are reusable by the next migration plan for Volumes, Registries, Domains, Access and platform administration.

## Follow-up Plans

After Phase 1 is verified, create separate plans using these primitives for:

1. Volumes + Registries + Domains inventories/detail/forms.
2. Applications/SingleApps + attachments/networking/runtime configuration.
3. Tenant access/identity/credentials/billing/operations/audit.
4. Platform administration and remaining zero-raw-data cleanup.
5. Final responsive/accessibility/polish sweep and release integration.
