# ResourcePortal Azure-like Web Console Redesign

Date: 2026-09-11
Status: DESIGN COMPLETE — awaiting implementation approval
Base: `feat/production-preview-ui` at `704c7c1beb35dc8672db58c30b2d273726afd86b`

## 1. Purpose

ResourcePortal Web Console must stop looking like a generic UI over REST payloads and become a coherent cloud management portal for users coming from Azure, AWS, GCP and similar platforms.

The redesign is inspired by Azure Portal information architecture and interaction patterns, but it must remain ResourcePortal-branded. We reuse interaction ideas, hierarchy, density and navigation conventions; we do not copy Microsoft branding, product names, logos, proprietary illustrations or exact visual assets.

The resulting console must feel operational, predictable and dense enough for infrastructure work while remaining understandable to users who are not familiar with ResourcePortal internals.

## 2. Primary goals

1. Introduce a stable Azure-like application shell with clear global navigation and tenant/resource context.
2. Replace hand-drawn and inconsistent iconography with a single Fluent-style icon system.
3. Remove raw JSON and generic object dumps from all normal user-facing views.
4. Replace layout-expanding action controls with stable command bars and overflow menus.
5. Make resource creation feel like provisioning infrastructure, with guided steps, explanations and a real Review + create stage.
6. Use tables for inventories, property grids for details, timelines/tables for activity and forms for configuration.
7. Make resource pages consistent across tenants, app groups, applications, volumes, registries, domains, identities and platform resources.
8. Preserve existing backend API contracts unless a missing read model makes a usable UI impossible.
9. Keep desktop as the primary operations experience while making tablet/mobile layouts predictable rather than merely scaled down.

## 3. Non-goals

- Do not recreate Azure Portal pixel-for-pixel.
- Do not introduce Microsoft branding.
- Do not redesign backend domain models in this stage.
- Do not add fake functionality, fake global search or controls that are not connected to real actions.
- Do not expose a user-facing JSON editor as a shortcut for unfinished forms.
- Do not convert every object into a card.
- Do not build a generic low-code schema renderer that blindly exposes arbitrary backend fields.

## 4. Current-state findings

The current preview already contains useful work that must be preserved:

- a production-oriented shell,
- tenant navigation,
- readable scalar/status rendering,
- a first guided create workspace,
- human-readable field labels,
- resource filtering and inventory tables.

However, the current architecture still has patterns that conflict with the target UX:

- `ReadableDataView` can expose `Technical JSON` with `JSON.stringify`;
- creation review can serialize arrays/objects using `JSON.stringify`;
- `JsonPayloadForm` is a generic payload editor and can expose generic object key/type/value editing;
- `ResourcePanel` derives columns from arbitrary API object keys;
- resource glyphs are hand-written inline SVGs;
- actions are owned by individual panels instead of one stable command-bar pattern;
- tenant navigation uses generic dots instead of meaningful icons;
- generic object rendering risks exposing implementation names, IDs and backend structure instead of user concepts.

These patterns are transitional and must not survive as the default UX.

## 5. Design principles

### 5.1 User concept over API shape

The Web Console renders ResourcePortal concepts, not JSON structures.

Every displayed field must answer at least one of these questions:

- What is this resource?
- Is it healthy?
- Where does it run?
- What does it consume?
- What is it connected to?
- What can the user do next?
- What changed recently?

Unknown backend properties are not automatically displayed.

### 5.2 Stable layout

Clicking an action must never cause the command bar, page header or navigation to grow unpredictably.

Menus open as overlays/popovers. Creation and editing open as dedicated workspace content, drawer, dialog or page according to task complexity.

### 5.3 Explicit actions

Primary actions are visible and named by outcome: `Create application`, `Start`, `Stop`, `Restart`, `Refresh`, `Delete`.

Secondary actions live under a stable `More actions` overflow menu.

### 5.4 Dense but readable

The portal should resemble an infrastructure management tool rather than a marketing dashboard. Tables, labels, status indicators and compact command bars are preferred over oversized cards.

### 5.5 No raw data

Normal user-facing routes must not contain:

- `Technical JSON`,
- `<pre>{JSON.stringify(...)}</pre>`,
- raw request/response payloads,
- generic object key/type/value editors,
- automatically rendered arbitrary object trees.

Technical identifiers may appear where operationally useful, but with a label and copy action rather than as an object dump.

## 6. Visual language

### 6.1 Typography

Use the existing system font stack. Typography should be compact and neutral:

- page title: 24–28 px,
- resource title: 20–24 px,
- section title: 16–18 px,
- body: 13–14 px,
- metadata/captions: 12 px.

Avoid large hero typography inside authenticated management routes.

### 6.2 Spacing and surfaces

Use a 4 px base spacing scale. Primary content uses 16–24 px section spacing. Cards use modest radius and borders. Large rounded `2xl` marketing-card styling should be reduced in operational views.

Preferred surfaces:

- app shell background,
- left navigation surface,
- white workspace surface,
- subtle section separators,
- compact bordered panels only when grouping is needed.

### 6.3 Color

ResourcePortal keeps its own brand color but uses Azure-like restraint:

- brand/accent for selected navigation and primary actions,
- neutral grays for chrome,
- green for successful/healthy states,
- amber for warning/degraded/pending states,
- red for failure/destructive states,
- blue for information and active states.

Color is never the only status signal.

## 7. Icon system

Add one canonical icon source: `@fluentui/react-icons`.

Use regular icons by default and filled variants only for selected/active states where helpful.

Create a ResourcePortal icon map so product code imports semantic icons instead of arbitrary package names.

Example semantic map:

- Home -> Home
- Tenant -> Building/Organization
- App group -> Apps/List
- Application -> Cube/Box
- Volume -> HardDrive/Database
- Registry -> Archive/Box
- Domain -> Globe
- Networking -> NetworkCheck/Globe
- Secret -> Key/Lock
- Identity -> Person/People
- Access -> Shield/PersonKey
- Operations -> ArrowSync/Tasks
- Audit -> DocumentText/History
- Monitoring -> Pulse/DataTrending
- Infrastructure -> Server
- Settings -> Settings
- Delete -> Delete
- Deploy/Start -> Play
- Stop -> Stop
- Restart -> ArrowCounterclockwise
- Refresh -> ArrowSync

Inline bespoke SVG glyphs should be removed unless a ResourcePortal-specific concept has no suitable library icon.

## 8. Application shell

### 8.1 Global layout

Desktop structure:

```text
Top bar
+----------------+-----------------------------------------------+
| Global nav     | Breadcrumbs / page context                    |
|                | Page header + command bar                     |
|                |-----------------------------------------------|
|                | Workspace                                     |
+----------------+-----------------------------------------------+
```

The global navigation width should be stable at approximately 224–240 px. It may collapse to icons on medium layouts, but icon-only navigation must provide tooltips and accessible labels.

### 8.2 Top bar

The top bar contains:

- ResourcePortal brand,
- tenant/workspace switch entry,
- optional route/context search only when connected to real functionality,
- system status/notifications when implemented,
- user menu.

Do not display fake controls for unsupported features.

### 8.3 Global navigation

Tenant context navigation:

- Overview
- App groups
- Applications where directly addressable
- Volumes
- Registries
- Domains
- Billing & quota
- People & access
- Machine credentials
- Operations
- Audit log

Platform administration is visually separated from tenant resources.

Every navigation item receives a semantic icon. Group labels remain subtle and non-clickable.

### 8.4 Breadcrumbs

All authenticated detail routes use breadcrumbs derived from real hierarchy, e.g.:

`Tenants / Production / App groups / shop-production / Applications / shop-api`

Breadcrumbs use names when available. IDs are fallback only.

## 9. Page header and command bar

Introduce shared components:

- `PageHeader`
- `ResourceHeader`
- `CommandBar`
- `CommandBarAction`
- `OverflowMenu`

A resource header contains:

- semantic resource icon,
- display name,
- resource type,
- status,
- key context such as tenant/app group.

Below it, a single-line command bar contains the most common actions.

Rules:

1. Primary actions remain visible at normal desktop widths.
2. Less common actions move into overflow.
3. The bar never expands vertically in response to `More actions`.
4. Overflow opens as an anchored popover/menu.
5. Destructive actions are separated visually and require confirmation.
6. Disabled actions explain why using tooltip/help text when practical.
7. On narrow widths, actions progressively move into overflow rather than wrapping into multiple rows.

## 10. Resource inventory pages

Inventory pages use `ResourceTable`, not card grids, except for small landing-page shortcuts.

Standard table capabilities:

- resource icon + clickable name,
- status,
- type-specific important fields,
- updated/created time when useful,
- row selection,
- per-row overflow menu,
- search/filter controls,
- empty state,
- loading skeleton,
- pagination when backend requires it.

Columns must be explicitly defined per resource type. Do not derive arbitrary columns from backend keys.

Examples:

### Applications

- Name
- Status
- Image
- Replicas
- CPU
- Memory
- Endpoint
- Updated

### Volumes

- Name
- Status
- Size
- Backend/filesystem
- Attachments
- Usage
- Updated

### Operations

- Operation
- Resource
- Status
- Started
- Duration
- Initiated by

IDs are not first-class columns unless required for a specific operational workflow.

## 11. Resource detail pages

Each major resource receives a consistent detail layout.

### 11.1 Resource navigation

A resource-specific secondary navigation can contain:

- Overview
- Activity log
- Configuration
- Networking
- Storage
- Secrets/configuration attachments
- Monitoring
- Operations
- Access control
- Properties

Only relevant sections are shown for each resource type.

### 11.2 Overview

Overview starts with an `Essentials` property grid containing curated fields.

Example for an application:

- Status
- Tenant
- App group
- Image
- Replicas
- CPU
- Memory
- Created
- Last deployment

Below essentials, use type-specific sections such as:

- Health
- Resource usage
- Endpoints
- Attached volumes
- Recent operations
- Recent activity

### 11.3 Properties

`Properties` is the most technical normal page, but it is still structured.

Use labelled fields, copy buttons for IDs and canonical values, tags/chips for arrays and formatted values for dates/sizes.

There is no generic JSON tree.

## 12. Status system

Introduce one shared `StatusBadge` vocabulary.

Canonical tones:

- positive: Running, Healthy, Ready, Active, Succeeded, Complete
- neutral: Stopped, Disabled, Unknown when not an error
- progress: Pending, Creating, Updating, Deploying, Reconciling
- warning: Warning, Degraded, Maintenance, Paused
- negative: Failed, Error, Unhealthy, Down, Invalid, Blocked

Each badge contains an icon/shape and text. The exact backend status remains available through mapping, but product-facing wording may be normalized where semantics are equivalent.

## 13. Creation experience

The current creation workspace evolves into a shared `ResourceCreationWizard`.

### 13.1 Wizard structure

Complex resources use steps such as:

`Basics -> Resources -> Networking -> Storage -> Environment -> Review + create`

Simple resources may use fewer steps, for example:

`Basics -> Review + create`

The step model is resource-specific; do not show empty irrelevant steps.

### 13.2 Form sections

Each step uses explicit field definitions and human descriptions.

Examples:

- resource picker instead of raw ID input,
- number stepper for replicas,
- CPU/memory units in labels,
- switch/toggle for boolean behavior,
- key/value table for environment variables,
- attachment picker for volumes/secrets/configs,
- domain picker for HTTP endpoints.

### 13.3 Review + create

Review is grouped by user concept:

- Basics
- Resources
- Networking
- Storage
- Environment
- Access

Objects/arrays must be rendered using tables, lists, chips or named sections. `JSON.stringify` is prohibited in review UI.

The final action text is specific: `Create application`, `Create volume`, `Create tenant`, etc.

A concise impact message explains what will happen, e.g.:

`ResourcePortal will create this application and make it available to the selected AppGroup. Deployment starts only when the configured workflow requires it.`

The message must reflect real backend behavior and must not promise deployment if creation only stores configuration.

## 14. Editing experience

Do not reuse a generic payload editor for all resources.

Editing patterns:

- short metadata edit -> right-side drawer or dialog,
- multi-section resource configuration -> dedicated edit page/workspace,
- dangerous operation -> confirmation dialog,
- repeated key/value data -> structured grid editor,
- references -> searchable picker/select.

The old generic object field editor is not a normal user-facing fallback.

## 15. Zero raw-data rule

### 15.1 Prohibited in authenticated product routes

- `Technical JSON` disclosure blocks,
- raw `<pre>` payloads,
- `JSON.stringify` used as a display representation,
- generic recursive object rendering of unknown data,
- arbitrary backend field names surfaced without a view mapping.

### 15.2 Allowed internal uses

`JSON.stringify` remains allowed for:

- tests,
- cloning/comparison implementation details,
- API transport internals,
- logging where security policy permits.

It must not be the rendered user representation.

### 15.3 Diagnostics

If future administrator diagnostics need raw payloads, they belong to a deliberately named diagnostic/developer surface gated separately from normal resource management. This redesign does not add such a surface.

## 16. Forms architecture

Deprecate `JsonPayloadForm` as the public conceptual API.

Introduce typed/shared primitives:

- `FormSection`
- `TextField`
- `TextAreaField`
- `NumberField`
- `NumberStepper`
- `SwitchField`
- `SelectField`
- `ResourcePicker`
- `MultiResourcePicker`
- `KeyValueEditor`
- `SecretField`
- `FormHelp`
- `FormErrorSummary`

Resource pages define a form/view model that maps domain fields to these primitives.

The backend DTO remains the submitted payload, but the user never needs to understand DTO shape.

## 17. Data presentation architecture

Replace generic `ReadableDataView` usage with explicit presentation primitives:

- `PropertyList`
- `PropertyGroup`
- `ResourceLink`
- `CopyableValue`
- `TagList`
- `SizeValue`
- `DateTimeValue`
- `DurationValue`
- `StatusBadge`
- `EmptyValue`

Resource-specific view adapters choose which fields are visible and how they are formatted.

Unknown fields are ignored until intentionally designed.

## 18. Dashboard

Tenant overview is a control-plane dashboard, not a marketing landing page.

Recommended sections:

1. Resource counts
2. Health summary
3. Attention required
4. Recent resources
5. Recent operations
6. Quota/resource usage

Cards are appropriate for high-level metrics, but inventories remain tables.

`Attention required` only contains actionable problems. Do not duplicate healthy information there.

## 19. Loading, empty and error states

Introduce consistent states:

### Loading

Use skeletons matching the final table/property layout. Avoid large layout shifts.

### Empty

An empty state explains:

- what this resource type is,
- why the list is empty,
- one primary next action when the user has permission.

### Error

Use a shared `ErrorCallout` with:

- human summary,
- safe error code when useful,
- retry action when safe,
- correlation/request ID in a copyable technical-details row when available.

Do not dump backend error objects.

## 20. Responsive behavior

### Desktop >= 1200 px

- full global navigation,
- full command bar,
- wide tables,
- optional resource secondary navigation.

### Medium 768–1199 px

- collapsible global navigation,
- command-bar overflow increases,
- tables remain horizontally scrollable where necessary,
- secondary resource nav may collapse into a drawer/dropdown.

### Small < 768 px

- global nav becomes drawer,
- command bar shows primary action plus overflow,
- forms become single-column,
- wizard step labels may reduce to compact step indicator,
- property grids become stacked,
- tables may use carefully selected compact columns with detail drill-in.

Controls must not shrink below usable hit targets and must not wrap unpredictably.

## 21. Accessibility

Required:

- keyboard-operable navigation, menus, dialogs and wizard,
- visible focus styles,
- semantic headings,
- `aria-current` for active navigation,
- labels for icon-only controls,
- tooltips for ambiguous icon-only actions,
- status text in addition to color,
- correct dialog/menu focus management,
- no click-only hidden interaction on arbitrary table/container surfaces.

## 22. Component boundaries

Target shared component structure:

```text
components/
  shell/
    app-shell.tsx
    top-bar.tsx
    global-nav.tsx
    breadcrumbs.tsx
  command/
    command-bar.tsx
    overflow-menu.tsx
  resource/
    resource-header.tsx
    resource-table.tsx
    resource-nav.tsx
    property-list.tsx
    status-badge.tsx
    values.tsx
  forms/
    fields.tsx
    resource-picker.tsx
    key-value-editor.tsx
    wizard.tsx
    review.tsx
  feedback/
    error-callout.tsx
    empty-state.tsx
    loading-state.tsx
    toast.tsx
    confirm-dialog.tsx
```

Resource-specific page/view models remain under `pages/` or resource feature directories.

Avoid another single oversized `resource.tsx` that owns fetching, table generation, mutation forms, rendering, actions and error handling simultaneously.

## 23. State and API behavior

Existing API requests remain authoritative.

The redesign may introduce view-model mapping functions but does not silently change API payloads.

Mutation feedback rules:

1. disable duplicate submit while a mutation is active;
2. show one success notification, not duplicate inline + toast messages;
3. update/reload the affected resource view after success;
4. preserve API correlation IDs in structured error details;
5. optimistic updates are not required for infrastructure mutations.

## 24. Testing strategy

### 24.1 Unit/component tests

Add tests for:

- command bar overflow behavior,
- navigation active states,
- icon labels,
- status mapping,
- property formatting,
- zero-raw-data rule,
- wizard step navigation,
- review rendering for nested/list fields,
- destructive confirmations,
- responsive class/contracts where practical.

### 24.2 Browser E2E

Browser tests must cover at minimum:

- tenant selection,
- create tenant,
- create AppGroup,
- create application configuration,
- create volume,
- common resource action,
- overflow menu action,
- resource detail navigation,
- review step is non-mutating,
- final create action produces exactly one mutation,
- no layout-expanding `More` behavior.

Existing Stage 20 real-Swarm browser smoke must be updated to drive the actual creation wizard rather than assuming the old direct-submit flow.

### 24.3 Static raw-data guard

Add a production UI test that fails when authenticated resource UI introduces prohibited render patterns such as:

- `Technical JSON`,
- display-oriented `<pre>` payload dumps,
- `JSON.stringify` directly inside JSX display paths.

The guard must avoid false positives for test code and internal cloning logic.

## 25. Migration phases

### Phase 1 — Foundations

- add Fluent icon dependency and semantic icon map,
- add design tokens/spacing refinements,
- split shell components,
- implement global nav icons,
- implement breadcrumbs,
- implement command bar and overflow menu,
- establish responsive behavior.

### Phase 2 — Presentation primitives

- implement status system,
- implement property/value components,
- implement explicit `ResourceTable`,
- implement shared loading/empty/error states,
- remove `Technical JSON` from normal routes.

### Phase 3 — Creation and editing

- replace public `JsonPayloadForm` usage with typed field primitives,
- implement shared wizard shell,
- implement structured review,
- implement resource pickers and key/value editors,
- migrate tenant/AppGroup/application/volume creation first.

### Phase 4 — Resource pages

- Tenant
- AppGroup
- Application
- Volume
- Registry
- Domain/HTTP endpoints
- Identity/access resources

Each resource receives explicit inventory columns, overview essentials, command actions and properties.

### Phase 5 — Operations and platform administration

- operations,
- audit,
- billing/quota,
- infrastructure,
- maintenance,
- credentials and identity providers.

### Phase 6 — Responsive/accessibility polish

- keyboard flows,
- focus behavior,
- mobile/tablet navigation,
- command overflow at breakpoints,
- skeleton/layout stability,
- final visual consistency pass.

### Phase 7 — E2E and production validation

- full web test suite,
- Docker production build,
- Codespaces preview smoke,
- federation tests,
- real Swarm browser smoke,
- deploy preview image to the test/production-preview environment only after tests pass.

## 26. Acceptance criteria

The redesign is complete only when all of the following are true:

1. All authenticated resource pages use the new shell/navigation language.
2. Every primary navigation entry has a meaningful canonical icon.
3. No normal route shows `Technical JSON` or raw payload dumps.
4. No creation review renders objects via `JSON.stringify`.
5. Generic unknown backend fields are not automatically displayed.
6. Resource inventory tables have explicitly defined columns.
7. `More actions` opens an overlay and never changes command-bar geometry.
8. Creation flows clearly communicate scope, effect and final mutation.
9. Review steps do not mutate backend state.
10. Final create submits exactly once.
11. Destructive actions require explicit confirmation.
12. Status is represented consistently by text + icon/tone.
13. Desktop, tablet and mobile layouts avoid unusable shrinking/wrapping.
14. Keyboard navigation and focus states work for menus, dialogs and wizard flows.
15. Existing backend API compatibility is preserved unless a separately reviewed backend change is required.
16. Production Docker build succeeds.
17. CI and Web Console browser tests pass.
18. Real-Swarm Stage 20 browser test is aligned with the new wizard and passes before the feature is treated as production-ready.

## 27. Rollout and compatibility

The redesign should be implemented on `feat/azure-like-web-console-redesign`, based on the current preview UI branch.

Do not overwrite the installed ResourcePortal release version merely to preview the UI. Preview deployments may replace only the Web service image while preserving the release manifest state, as already done for the current preview environment.

Before merge, the branch must be brought up to date with `main`, conflicts resolved explicitly, and the complete Web/CI integration suite rerun on the final head SHA.

## 28. Implementation recommendation

The implementation should prioritize shared primitives and one end-to-end vertical slice before mass migration.

Recommended first vertical slice:

1. new shell + icon system + command bar,
2. AppGroups inventory,
3. AppGroup resource overview,
4. create AppGroup wizard,
5. action overflow,
6. updated browser E2E.

Once that slice is stable, repeat the pattern for Applications, Volumes and remaining resource families.

This avoids a large visual rewrite with no working reference and gives the rest of the console a tested pattern to follow.
