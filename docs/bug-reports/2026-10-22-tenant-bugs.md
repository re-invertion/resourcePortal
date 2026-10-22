# ResourcePortal tenant Bug Reports — 2026-10-22

Source: ResourcePortal Platform Admin MCP (12 unresolved Bug Reports, snapshot 2026-10-22).
This is a release evidence and duplicate-triage ledger, not an instruction to close reports.
The GitHub issues listed below are *related areas*, not automatically duplicates or fixed by this patch.

| RP report UUID | Symptom / acceptance | Code change in this branch | Related open GitHub issues | Relation |
| --- | --- | --- | --- | --- |
| b9944441-0a2a-4103-8f43-bdc994c52747 | Tenant MCP tool list only | Tenant-scoped catalog guard + test | #213 | MCP area; DCR timeout unrelated |
| 4e51f959-23c4-419e-97ac-c4e67552e9c6 | Attach volume opens modal | ApplicationEdit dialog + test | #221 | Storage area; host permissions unrelated |
| eea52b99-b989-4cd6-9989-8182552a3dec | Attach configuration opens modal | ApplicationEdit dialog + test | — | No matching GitHub issue |
| 8e9957a6-26f8-49e8-95ad-59deb4d6e2ce | Config modal, syntax highlighting | AppGroupConfig read-only preview | — | No matching GitHub issue |
| 1c36603d-d56f-4104-9695-124edf9574e9 | Compact MCP Details | Collapsed protocol details | #213 | DCR timeout unrelated |
| 2f4fba8f-5985-47f5-b7e9-752c0ec1f57f | Full-width VPN table | Networking table layout | #210 | Firewall atomicity unrelated |
| ffab81ae-33ff-41ef-a2db-302f0f153b78 | Remove read-only route copy | Networking graph details | — | No matching GitHub issue |
| 357a8936-c567-4f2a-aa49-615e9f045bc1 | Converge 3+ app routes into shared network line/purple CIDR pill | Network node compact shared hub | #217 | Missing egress snapshot unrelated |
| 027f46a2-44fb-45e1-abd1-95074a44dd62 | Remove legacy third-party auth | Legacy *UI* removed, backend policies deliberately retained | #238, #286 | Related auth migration, NOT resolved |
| efaa617b-b775-4038-94bc-4757c31dfc33 | Remove duplicated application Health | Overview retained, legacy URL rendered as Overview | — | No matching GitHub issue |
| 255fc11b-f5be-49c3-87bd-194436bf7726 | Network stuck Provisioning | Standalone Network reconciliation + test | #210, #217 | Same networking subsystem; different root causes |
| f46bc53f-5abb-4239-bc0e-821f7272ac86 | Volume details page with attachments, Grow/Delete only there | Tenant volume detail route, API display of attached app name, move actions | #221 | Same storage domain; permissions unrelated |

## Separate GitHub open issues (NOT incorporated into this tenant UI scope)

- #286: live tenant OIDC two-tenant security certification requires HTTPS issuer and real test tokens. It must **not** be considered fixed by hiding legacy controls. Preserve native-login-only migration safety gates.
- #242: historical installer mktemp failure; release-specific verification required, not related to any of these 12 reports.
- #238: tenant IdP policy bypass; do not retire backend controls before credential provenance enforcement/migration.
- #221: world-writable volume storage permissions; host-isolation patch requires separate release/regression scope.
- #217: egress-guard policy snapshot outage; not the network Provisioning defect.
- #213: outbound DCR timeouts; not tenant MCP catalog rendering.
- #210: non-atomic firewall updates in Gate/Device VPN; not VPN table UX.

Each GitHub issue remains open until separately proven fixed under its own acceptance criteria. Do not close it by association or double-count it as a second RP Bug Report.

## Closure gate

Do not resolve any RP report until its corresponding behavior has passed regression tests and a signed RP release has been published. Production-dependent status (#255) requires a post-deployment read-only observation by the owner. The authentication-removal report (#027) remains open until safe user migration and retirement of legacy backend rules have been verified.
