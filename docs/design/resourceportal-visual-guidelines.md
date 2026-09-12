# ResourcePortal Visual Guidelines

This document is the developer handoff for the **ResourcePortal — Visual Guidelines** Penpot page created on 2026-09-12. It defines the target visual language for the ResourcePortal Web Console. It is intentionally independent of the current production styling and should be treated as the design baseline for Stage 21 migration work, not as evidence that the Web UI has already been migrated.

## Status and scope

- Design direction: **Fluent 2-inspired, Azure-like usability, ResourcePortal identity**.
- Primary theme: light.
- Product character: calm, technical, professional, enterprise, cloud-native and accessible.
- Typeface: Inter.
- Layout grid: 4 px base grid.
- Primary action color: ResourcePortal blue family.
- Penpot contains real design tokens, reusable components and component variants, plus production-oriented reference screens.
- This design baseline does **not** change backend/API contracts, SSR/MPA routing, BFF/session behavior, CSRF, tenant isolation or backend-authoritative RBAC.

### Canonical logo caveat

The connected Penpot file and the repository did not expose the canonical ResourcePortal vector/logo asset during this work. The logo was therefore **not redrawn or modified**. The `02 Logo` board intentionally contains canonical-asset slots and usage rules. The current blue scale is a provisional design baseline and must be visually calibrated to the exact logo blue after the approved vector asset is imported into Penpot.

## Penpot organization

The page is named `ResourcePortal — Visual Guidelines` and is organized as:

- `00 Cover`
- `01 Principles`
- `02 Logo`
- `03 Colors`
- `04 Typography`
- `05 Spacing & Shape`
- `06 Iconography`
- `07 Buttons`
- `08 Forms`
- `09 Status`
- `10 Navigation`
- `11 Cards`
- `12 Tables`
- `13 Feedback`
- `14 Dashboard`
- `15 Create Resource`
- `16 Design Tokens`

The file passed a containment review: no section content is intentionally positioned outside its owning board.

## Brand principles

| Principle | Rule |
| --- | --- |
| Clarity | Information should be easy to find and understand. |
| Confidence | Interfaces should feel predictable, reliable and professional. |
| Simplicity | Hide unnecessary complexity and focus on the task. |
| Control | Users should understand what will happen before they perform an action. |

## Token architecture

The matching machine-readable snapshot is stored in `docs/design/resourceportal-design-tokens.json`.

### Color

#### Brand scale

| Token | Value |
| --- | --- |
| `color.brand.10` | `#F3F8FF` |
| `color.brand.20` | `#E7F1FF` |
| `color.brand.30` | `#CFE3FF` |
| `color.brand.40` | `#A8CCFF` |
| `color.brand.50` | `#75ADFF` |
| `color.brand.60` | `#3B8AF4` |
| `color.brand.70` | `#1769E0` |
| `color.brand.80` | `#1056BB` |
| `color.brand.90` | `#0B438F` |
| `color.brand.100` | `#073164` |

Semantic brand roles:

- `color.brand.primary` → `color.brand.70`
- `color.brand.primaryHover` → `color.brand.80`
- `color.brand.primaryPressed` → `color.brand.90`
- `color.brand.subtle` → `color.brand.20`
- `color.brand.background` → `color.brand.10`

#### Neutral roles

| Token | Value | Use |
| --- | --- | --- |
| `color.neutral.canvas` | `#F7F9FC` | application canvas |
| `color.neutral.secondary` | `#F1F4F8` | grouped/secondary surfaces |
| `color.neutral.surface` | `#FFFFFF` | cards and panels |
| `color.neutral.surfaceHover` | `#F7F9FC` | hover surface |
| `color.neutral.border` | `#D9E0EA` | default divider/border |
| `color.neutral.borderStrong` | `#AAB4C3` | controls/strong separators |
| `color.neutral.textPrimary` | `#172033` | primary text |
| `color.neutral.textSecondary` | `#5B6678` | supporting text |
| `color.neutral.textDisabled` | `#98A2B3` | disabled text |
| `color.neutral.navy` | `#122033` | optional dark brand surface |

#### Semantic roles

| Meaning | Foreground | Background |
| --- | --- | --- |
| Success | `#137A4A` | `#EAF7F0` |
| Warning | `#9A6700` | `#FFF4CE` |
| Error | `#C42B1C` | `#FDEBEC` |
| Information | `#1769E0` | `#E7F1FF` |

Status must never be communicated by color alone. Pair color with an icon/indicator and text.

### Typography

| Token | Size / line height | Weight | Intended use |
| --- | --- | --- | --- |
| `text.display` | 48 / 56 | 600 | major statements |
| `text.h1` | 36 / 44 | 600 | page titles |
| `text.h2` | 28 / 36 | 600 | section titles |
| `text.h3` | 22 / 30 | 600 | panel titles |
| `text.subtitle` | 18 / 26 | 500 | supporting heading |
| `text.bodyLarge` | 16 / 24 | 400 | lead content |
| `text.body` | 14 / 20 | 400 | default UI content |
| `text.bodySmall` | 13 / 18 | 400 | dense tables/helpers |
| `text.caption` | 12 / 16 | 400 | metadata |
| `text.label` | 13 / 18 | 500 | form/control labels |

### Spacing

`spacing.4`, `spacing.8`, `spacing.12`, `spacing.16`, `spacing.20`, `spacing.24`, `spacing.32`, `spacing.40`, `spacing.48`, `spacing.64`.

### Shape

| Token | Value |
| --- | ---: |
| `radius.small` | 4 |
| `radius.medium` | 6 |
| `radius.large` | 8 |
| `radius.xlarge` | 12 |
| `radius.round` | 999 |
| `border.thin` | 1 |
| `border.strong` | 2 |

### Elevation

`shadow.0` through `shadow.4` define restrained elevation. Cards should rely primarily on surface and border; shadow is supplemental, not the main separator.

## Component library contract

Penpot includes reusable components and variant groups for the core system.

### Buttons

Types:

- Primary
- Secondary
- Subtle
- Transparent
- Danger

States:

- Default
- Hover
- Pressed
- Focus
- Disabled
- Loading

Sizes:

- Small: 32 px high
- Medium: 40 px high
- Large: 48 px high

The Penpot `Button variants` group exposes `Type`, `State` and `Size` axes. Primary is the dominant action; Danger is separate and must not visually compete with Primary.

### Forms

Designed controls:

- Text input
- Search input
- Password
- Textarea
- Select
- Combobox
- Checkbox
- Radio
- Toggle
- Number input

Text input states are represented as variants: Default, Hover, Focus, Filled, Disabled, Error and Success.

Form anatomy is always:

`Label → Control → optional helper/validation text`

Placeholder text must not be the only label. Infrastructure-oriented fields should include a short explanation of impact when the setting is not self-evident.

### Status badges

The badge vocabulary includes:

`Running`, `Healthy`, `Active`, `Pending`, `Deploying`, `Warning`, `Error`, `Stopped`, `Disabled`, `Archived`, `Unknown`.

Each badge combines color, an icon/indicator and text.

### Tabs

Horizontal tab variants cover Default, Hover, Active and Disabled. Active state uses restrained brand emphasis and a clear indicator.

### Cards

Card variants cover Metric, Resource, Status, Action, Information, Warning and Empty-state. Cards should remain compact and task-oriented.

### Tables

The reference table includes:

- search/filter toolbar,
- compact 44 px rows,
- table header,
- status column,
- actions column,
- Default/Hover/Selected row variants,
- pagination.

### Feedback

Callout variants cover Information, Success, Warning and Error. Separate references exist for empty, loading/skeleton and recoverable error states.

### Navigation

Navigation item variants cover Default, Hover and Active. The reference shell uses:

- light/neutral left navigation,
- grouped Tenant navigation,
- visually separate Platform Admin section,
- topbar with breadcrumb, search and user actions,
- light content canvas.

A reusable `Page Header` component is also included.

## Reference screens

### Tenant Overview

The `14 Dashboard` board demonstrates a realistic production layout with:

- page heading and welcome copy,
- quick actions,
- Applications / Running workloads / Storage usage / Current balance metrics,
- Needs attention,
- Recent applications,
- Recent activity,
- Resource status.

It is a reference composition, not a new backend dashboard contract.

### Create application

The `15 Create Resource` board demonstrates a guided cloud-console flow:

- Basics
- Runtime
- Resources
- Networking
- Review + create

The first step shows visible field labels, concise helper text, contextual help, progressive disclosure under `Advanced`, and a plain-language review summary before creation.

## Interaction principles

1. **Primary action** — one dominant action per task area.
2. **Dangerous actions** — destructive actions do not compete visually with the primary action.
3. **Progressive disclosure** — advanced settings stay behind an explicit `Advanced` disclosure until needed.
4. **Technical details** — raw JSON and low-level diagnostics are optional, secondary views rather than the default UI.
5. **Confirmation** — confirm only operations that are genuinely risky or destructive.
6. **Feedback** — asynchronous operations communicate `loading → success/error` and provide a clear next step.

## Stage 21 implementation order

The Penpot file is the visual specification. Web implementation should be migrated incrementally to avoid changing behavior and security contracts.

1. Introduce the token layer in `packages/resourceportal-web` and map existing Tailwind/CSS values to semantic roles.
2. Migrate the shared shell, navigation item and page header.
3. Implement base primitives: Button, Input, Select, Checkbox, Radio, Toggle, Badge, Tabs, Card, Callout and Table Row.
4. Migrate high-traffic resource tables and creation/edit forms to the primitives.
5. Standardize status vocabulary and feedback states across AppGroup, SingleApp, deployment, storage, network, identity and billing screens.
6. Apply the same system to Dashboard and App Group workspace compositions.
7. Complete the remaining Stage 21 gaps: overlay library, final theme architecture, responsive device matrix, accessibility audit and visual regression suite.

The existence of this design baseline should therefore be recorded as **Stage 21 design-system specification ready / implementation still partial**, not as Stage 21 COMPLETE.
