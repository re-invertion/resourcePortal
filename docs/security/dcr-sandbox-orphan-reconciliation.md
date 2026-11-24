# Read-only reconciliation of historic sandbox DCR registrations (#213)

**Scope:** Existing sandbox issuer `https://auth-sandbox.resource-portal.pl` only. This is not a production change, rollout or authorization to register/delete an OAuth client.

## Why an empty project search is not enough

Anonymous RFC7591 registration in ZITADEL v4.17.0 creates the client under the **instance default organization**. The ResourcePortal bootstrap/Management token can belong to another organization. A search implicitly scoped to the token's organization might return no project or no candidates while the registered client still exists.

The verifier `scripts/audit-sandbox-dcr-orphans.mjs` therefore:

1. Confirms the exact HTTPS issuer and its advertised DCR registration URL using read-only discovery.
2. Uses an **independently authorized sandbox-only audit credential** to call `GET /admin/v1/orgs/default`, requiring ZITADEL `iam.read`, and verifies a numeric default-org ID. A denial or malformed identity is **UNKNOWN**, not absence.
3. Restricts subsequent paginated Management API project and application searches to that org using `x-zitadel-orgid`. A permitted read-only role on that organization/project is also required.
4. Verifies list-details and total-count consistency, all pages (up to the hard-coded bound), unique application IDs, and exact project identity. Missing nonzero totals, changing counts, duplicate pages and unexpected HTTP statuses are **UNKNOWN**.
5. Reports only candidate application/client identifiers with the exact historical name prefix `RP sandbox scoped DCR verify `. It never registers, updates, deletes, retries registration or echoes bearer tokens.

The search APIs use HTTP POST *for read-only search*. Only `/management/v1/projects/_search` and `/management/v1/projects/{projectId}/apps/_search` are allowed search endpoints. An HTTP 200 from a health/discovery endpoint is not evidence of complete access.

## Operator procedure

- First confirm the operator has explicit authority for this **sandbox** issuer and the required `iam.read` plus read-only Management project/app privileges. Do not borrow credentials from production, extract running service secrets or bypass denied permissions.
- Inject `ZITADEL_SANDBOX_AUDIT_TOKEN` through an approved secret-injection mechanism into a restricted shell; do not paste it into a chat, issue, command line, CI log or environment dump. Then run `node scripts/audit-sandbox-dcr-orphans.mjs` in the checked-out PR.
- Exit `0`: a *single read-only snapshot* with no matching prefixed clients. **Not deletion proof**: correlate audit/eventstore history and the earlier registration time window to determine whether the accepted client was removed or renamed.
- Exit `3`: one or more candidate clients in the verified default org; preserve minimally necessary identifiers in a restricted incident log and independently cross-check creation/last-change history and ownership.
- Exit `1` or `2`: credential denied, incomplete search, wrong issuer, or other **UNKNOWN** outcome; do not make absence or cleanup claims.

If a unique historical orphan is confirmed, a separately authorized operator must approve **one exact-client deletion**, capture the validated application ID and expected organization, and verify absence with a bounded RFC7592 read *when a valid registration credential is actually available* plus a second complete, independent default-org Management inventory. Without that credential, record that RFC7592 verification was unavailable; do not invent it. No blind/bulk deletion and no additional sandbox DCR registration until reconciliation completes.

## Evidence status

GitHub Actions isolated ZITADEL v4.17.0 tests have independently proven exact-token `DELETE 204` + `GET 404` + complete Management inventory absence for **new disposable CI clients**. These tests do not resolve the earlier sandbox registration. The sandbox audit needs an appropriately authorized credential; absent that, the historical client's state remains **UNKNOWN**.

None of this certifies live ChatGPT refresh/revoke or cross-role RBAC, native MFA/recovery/migration, exact-main signed release, or six real RP/ZITADEL database/eventstore rollback scenarios. Those are separate protected acceptance gates.
