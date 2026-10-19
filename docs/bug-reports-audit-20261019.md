# Platform Bug Reports audit — 2026-10-19

Source: ResourcePortal Platform Admin Bug Reports, 94 total; 24 open (20 P2 and 4 P3) at production v0.2.88, GitHub main 3716266c97654323fb532842b00bdc26352fd5fe.

**Evidence policy:** IMPLEMENTED IN MAIN is **only a code-level candidate** until regression tests and the deployed release are confirmed. It is **not** an authorization to resolve reports. VERIFY means further investigation required. OPEN IN CODE means the behavior is still present in current main.

| Report UUID prefix | Requirement | Preliminary assessment | Evidence / next action |
|---|---|---|---|
| d3d21e11 | Topology auto-focus/domain placement | OPEN IN CODE | Graph initializes focusNetworkId for >15 apps; update to all nodes and move domains |
| fa27661a | Session/cookie reset on auth error | VERIFY | Review auth failure and logout behavior across OIDC change |
| 41971431 | Tenant display name and logo | IMPLEMENTED IN MAIN | tenant-settings branding form, confirmation modal, API tenant-logo.spec.ts |
| f4f6a707 | Applications refresh automatically | IMPLEMENTED IN MAIN | applications.tsx setInterval; applications.test.tsx retry/poll |
| 480b8d79 | Public domain labels crossing lines | OPEN IN CODE | tenant-networking-graph.tsx internet-route edge label placement |
| 179a5539 | Add VPN menu location | OPEN IN CODE | move Add VPN control/menu to right of header |
| 8a57e29e | UX-14 Quick action wording | IMPLEMENTED IN MAIN | tenant-dashboard.tsx uses Volumes and Domains for list navigation |
| ece223e2 | UX-13 registry and volume UX | VERIFY | Review create-app-wizard and storage selectors |
| 08c37dc7 | UX-12 Invite user shortcut | IMPLEMENTED IN MAIN | tenant-access-pages.tsx direct Invite user CTA |
| 5b832e69 | UX-10 implementation terms | VERIFY | Check app-edit protocol names and GPU help |
| bd6f5a7d | UX-09 network map readability | VERIFY | Conflict: newer issue d3d21e11 demands complete map by default |
| 39d99516 | UX-08 graph runtime conflict | IMPLEMENTED IN MAIN | tenant-networking-graph uses effectiveRuntimeState and configured state |
| f15da43c | UX-07 cost estimates | IMPLEMENTED IN MAIN | create-app-wizard.tsx estimate PLN per hour/month |
| ac703ea3 | UX-06 billing quota and units | VERIFY | Inspect billing components and quota labels |
| d89cba1a | UX-05 role help on invite | IMPLEMENTED IN MAIN | tenant-access-pages shows selected role permissions |
| e606bf24 | UX-04 pending deployment UX | VERIFY | App editor pending bar and App Group deploy action |
| ffa230f1 | UX-03 domain assignment | IMPLEMENTED IN MAIN | domain-assignment.test.tsx verifies assign form + confirmation |
| b6aebd06 | UX-02 wizard HTTP follow-up | IMPLEMENTED IN MAIN | create-app-wizard.tsx review publishing checklist |
| 063c761a | UX-01 create application shortcut | IMPLEMENTED IN MAIN | applications.tsx Create application/Choose App Group, tests |
| 14416587 | Retry enabled for succeeded | IMPLEMENTED IN MAIN | mayRetryOperation; tenant-operation-fixes.test.tsx |
| 50608884 | Unformatted balance | IMPLEMENTED IN MAIN | tenant-dashboard.tsx formatPlnAmount; denomination distinct |
| 3fa376de | Operation Updated/error reason | IMPLEMENTED IN MAIN | operationUpdatedAt + Failure reason; regression tests |
| 7578cb76 | App Group Networking misroutes to Apps | IMPLEMENTED IN MAIN | app-group/route.test.tsx: routes App Group networking URLs to HTTP endpoints panel |
| 1cb5e515 | Dedicated app logs tab | IMPLEMENTED IN MAIN | app-group/app-detail.test.tsx: loads container logs only on dedicated Logs tab |

Expected sign-off: file-level evidence, relevant regression test, merged PR (where missing), successful release workflow/tag; only then mark a Bug Report resolved with version-specific note. Do not alter tenant production workloads as part of this audit.
