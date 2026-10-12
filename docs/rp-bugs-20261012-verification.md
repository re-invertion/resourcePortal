# ResourcePortal Bug Reports — release verification matrix (2026-10-12)

Source: Platform Admin MCP, 23 open reports checked on 2026-10-12. Source revision: `9e791e473eac30f040b65f94d74c03ab18d56816`. This matrix tracks code-level evidence, not production confirmation. Reports remain OPEN until deployed release is verified.

| Report ID | Area | Expected verification |
| --- | --- | --- |
| fa27661a | Auth: invalid session | Expired/invalid session is revoked by the backend and the browser can reauthenticate without manually clearing cookies; tests for failed login and logout fallback. |
| 41971431 | Tenant branding | Tenant admin can update display name and upload tenant logo behind a confirmation modal; access control, file constraints and consumers checked. |
| f4f6a707 | Application refresh | Applications listing reflects external changes via safe periodic refresh without breaking filters/unmount. |
| 480b8d79 | Network topology labels | Domain labels remain legible, above connector lines and away from overlap; browser test. Screenshot attached in source report. |
| 179a5539 | Network topology placement | Screenshot-specific control is moved to the right; check image before implementation. |
| 8a57e29e | UX-14 Quick actions | Action labels must match navigation result, or navigation opens create flow. |
| ece223e2 | UX-13 Storage | Registry link, volume sizing, usage and unit consistency in app flows. |
| 08c37dc7 | UX-12 Access | Direct invite access and clearer identity/policy sections. |
| 5b832e69 | UX-10 App editor copy | Human-readable transport and registry copy, GPU availability copy, resource tab wording. |
| bd6f5a7d | UX-09 Networking vocabulary | Default readable focus/zoom and consistent Gate wording. |
| 39d99516 | UX-08 Runtime status | Distinguish configured vs effective runtime state (including stopped group). |
| f15da43c | UX-07 Billing | Estimate PLN/h and PLN/month with assumptions, intelligible voucher and billing explanations. |
| ac703ea3 | UX-06 Quotas | Explicit unlimited vs unset vs unavailable, human units for bytes and usage/limit. |
| d89cba1a | UX-05 Invite roles | Describe permissions for selected role before final invite confirmation. |
| e606bf24 | UX-04 App deployment | Saved-not-deployed indicator and direct link to group deployment. |
| ffa230f1 | UX-03 Domain assignment | Discoverable assignment route from unassigned domain and endpoint. |
| b6aebd06 | UX-02 App create | Public access step or actionable post-create checklist. |
| 063c761a | UX-01 Application create | Explain App Groups and route to creating application from Applications page. |
| 14416587 | Operation Retry | Never render enabled Retry for Succeeded; server-side retry eligibility checked independently. |
| 50608884 | Billing precision | Format PLN to two decimals in dashboard and Billing; credits readable; currency stays visible. |
| 3fa376de | Operation diagnostics | Updated timestamp consistent with listing, failed-operation reason rendered if API provides it. |
| 7578cb76 | App Group networking | Networking link must render matching networking panel (not Apps list). |
| 1cb5e515 | App log navigation | App details have separate Logs tab. Screenshot attached in source report. |

Release guard: this branch is a patch series, therefore follow AGENTS.md targeted Fast Fix plus mandatory security smoke where needed; official protected main Merge Queue and automatic SHA-pinned release. No direct main pushes, manual tag or unverified issue closure.
## Implemented patch and focused regression evidence

Status: code is prepared locally in Workspace v2; this is **not** a deployed release. In particular, screenshots and UI regressions need final browser/production acceptance before marking source reports resolved.

| Report ID | Implementation | Local verification |
| --- | --- | --- |
| fa27661a | Always clear session cookies if revocation fails, permitting a new login | `src/auth/invalid-session-cleanup.spec.ts`; existing auth regressions |
| 41971431 | Tenant-scoped name and logo update, PNG/JPEG/WebP validation, audited metadata-only event, confirmation, tenant tiles and switcher | `src/tenants/tenant-logo.spec.ts`, `src/pages/tenant-branding.test.tsx` |
| f4f6a707 | Visible-tab application refresh every 15s; in-flight guard; unmount cleanup | `src/pages/applications.test.tsx` |
| 480b8d79 | Raised and staggered domain labels above links in ReactFlow diagram | `src/pages/tenant-networking.test.tsx`; browser visual check pending |
| 179a5539 | Relocated Add VPN menu to right control group | `src/pages/tenant-networking.test.tsx`; browser visual check pending |
| 8a57e29e | Dashboard shortcuts renamed to match their actual destinations | `src/pages/tenant-dashboard.test.tsx` |
| ece223e2 | Volume selector adds size/status/attachments, direct create link (new tab keeps wizard state), registry link, MiB/GiB conversion hint | `src/pages/app-group/create-app-wizard.test.tsx`, `src/pages/tenant-storage-pages.test.tsx` |
| 08c37dc7 | Direct invitation from Access, new invite route | `src/pages/tenant-access-pages.test.tsx` |
| 5b832e69 | Human-readable HTTP protocol, private-registry hint, GPU availability and Resources & scaling navigation | `src/pages/app-group/route.test.tsx`, app editor tests |
| bd6f5a7d | Default network focus when large, higher zoom minimum, Site/Device VPN menu | `src/pages/tenant-networking.test.tsx` |
| 39d99516 | Runtime state represented separately from desired state in topology; topology API supplies group state | `src/pages/network-status-display.test.ts`, networking service tests |
| f15da43c | Tenant-visible active price-list rates; estimate CPU/RAM in PLN/hour and PLN/730-hour month with explicit assumptions; billing series legend and voucher copy | `src/billing/tenant-estimate-rates.spec.ts`, `src/lib/compute-estimate.test.ts`, billing tests |
| ac703ea3 | Quota zero = enforced zero (not unlimited); unavailable vs unset; byte limits in GiB | `src/lib/billing-display.test.ts`, billing tests |
| d89cba1a | Role permission preview from actual grants and explicit invitation confirmation | `src/lib/role-capabilities.test.ts`, `src/pages/tenant-access-pages.test.tsx` |
| e606bf24 | Editor indicates saved draft is not deployed, links to App Group deployment | app editor tests |
| ffa230f1 | Unassigned domain can select group, app and endpoint with confirmation; App Group Networking links to domain administration | `src/pages/domain-assignment.test.tsx`, App Group networking tests |
| b6aebd06 | HTTP publication checklist: container port, endpoint, domain, deployment and final URL; background worker exception | app wizard tests |
| 063c761a | Create application entry action and group selection with explanatory copy | `src/pages/applications.test.tsx` |
| 14416587 | Retry hidden for succeeded or deployment mirror operations, eligible only on failed supported operations | `src/pages/tenant-operation-fixes.test.tsx`, operations service tests |
| 50608884 | PLN formatted to two decimals with visible currency; credits formatted separately | `src/lib/billing-display.test.ts`, `src/pages/tenant-dashboard.test.tsx` |
| 3fa376de | Timestamp from best available operation event and failure reason on failed detail view | `src/pages/tenant-operation-fixes.test.tsx` |
| 7578cb76 | App Group networking route renders endpoint management rather than app listing | `src/pages/app-group/route.test.tsx` |
| 1cb5e515 | Dedicated app Logs tab; fetch only when selected | `src/pages/app-group/app-detail.test.tsx`, route tests |

## Release safeguards

- Fast Fix uses explicit file-to-test classification; `tenant-ux-patch` covers the added React screens/utilities and regression tests. Unknown files still fail closed.
- Changes to API authentication, schema, pricing and networking have dedicated tests and require CI release gates.
- Topology API changes select fields and read-time mapping but do not modify the WireGuard/Swarm dataplane. The Fast Fix classifier nevertheless flags networking changes for mandatory VPN smoke, which must pass on the sanctioned CI environment.
- Scope limitations: this patch does not add a new advanced policy navigation hierarchy, redesign historical REV fields, or expose a full runtime resource-usage-versus-quota rollup. Those parts need separate UX acceptance and should not be represented as verified fixes.
- Neither GitHub PR/merge nor release/deployment nor RP Bug Report resolution has occurred at this stage; review, required checks, release and post-deploy verification are mandatory.
## Local validation results

- Web regression profile `tenant-ux-patch`: **60 / 60 passed**, 16 test files, Web TypeScript/lint succeeded.
- Tenant pricing and networking focused API tests: **34 / 34 passed**.
- Fast Fix path-classification test suite: **24 / 24 passed**; all 49 worktree modifications and new paths classified.
- API lint and Nest build: passed.
- Prisma schema validation: passed.
- Dependency audit (`npm audit --audit-level=high`): passed, 0 reported vulnerabilities.
- `git diff --check`: passed.
- Live WireGuard/Swarm smoke, merge queue, release publication and production acceptance: **not run locally**; required at the official protected release gate.

Note: the approved workspace destination `fix/rp-bugs-20261012` is not yet an official `fastfix/vX.Y.N-*` branch. The publication/release operator must preserve the patch-version Fast Fix naming and guards, or use a compliant full-gate route.
