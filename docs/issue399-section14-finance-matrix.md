# ResourcePortal #399 §14 — endpoint → UI → RBAC → regression matrix

This matrix documents existing supported API contracts at the source HEAD of PR #525.
It does **not** authorize a broader platform financial read, and does **not** claim
an isolated staging browser E2E or production operation has been executed.

| Read contract | Tenant UI entry | Server authorization / isolation | Regression / behavior |
| --- | --- | --- | --- |
| `GET /api/tenants/:tenantId/billing` | Tenant → Billing balance | `billing.read`, tenant ID scope | Existing billing and account tests; PLN/credit presentation |
| `GET /api/tenants/:tenantId/quota` | Tenant → Overview, Storage, Billing | Tenant-scoped policy read, not editable from tenant UI | `quotaBytesDisplay` and used/allocated/quota UI; no zero=unlimited |
| `GET /api/tenants/:tenantId/billing/usage-series?bucket=&from=` | Tenant → Billing usage chart | `billing.read` | Existing usage-series regression and chart unit tests |
| `GET /api/tenants/:tenantId/billing/transactions?limit=25&cursor=` | Tenant → Billing → Transactions | `billing.read`; `BillingReadService.listTransactions(tenantId)` | `tenant-billing-history.test.tsx` verifies cursor and current tenant |
| `GET /api/tenants/:tenantId/billing/usage-records?limit=25&cursor=` | Tenant → Billing → Usage records | `billing.read`; tenant account scoping in `BillingReadService` | `tenant-billing-history.test.tsx` exercises record selection, errors |
| `GET /api/tenants/:tenantId/billing/usage-summary` | Tenant → Billing → Usage summary | `billing.read`; server aggregated view | Distinguishes theoretical cost and charged cost; non-authoritative UI rounding |
| `GET /api/tenants/:tenantId/resource-bot/usage?limit=50` | Tenant → Billing → ResourceBot usage | `billing.read`, tenant ID filter on ResourceBotUsageRecord | `tenant-billing-history.test.tsx`; server limits to 100, UI asks for 50 |
| `GET /api/platform/billing/usage-series?tenantId=&bucket=` | Platform Admin → Billing aggregate charts | Platform-only aggregates | Existing platform billing coverage; **no** private transaction, billing balance, ResourceBot ledger, quota or tenant account reads from Platform Admin |

## Deliberate limitations

- The ResourceBot usage API offers **only the latest bounded list** and no
  cursor-based history. UI explicitly says it is not the full historic ledger.
- The transaction and usage-record endpoints provide server-side `nextCursor`
  pagination. The UI shows at most 25 rows per page and never invents a next page.
- No fabricated ResourceBot conversation transcripts, vouchers, secrets,
  transaction metadata or raw UUID identifiers in the basic billing view.
- Error responses do not become empty-success tables. The user is offered
  a retry while retaining the distinction between unavailable and zero records.
- `billing.read` is enforced by the backend. The UI provides no new permission
  mutation and does not relax tenant RBAC or Platform Admin separation.
- Price-list **inputs** retain original decimal precision; read-only display
  uses common PLN/credits formatting, with credit rate precision up to 8 places.
- All capacity figures show binary `GiB` for memory/storage (`2^30` bytes).
  Used, allocated, and policy quota remain independent dimensions. Pricing
  labels retain the API's distinct GB-based billing rate semantics and are
  not silently converted to GiB prices.
- Dates use a fixed `Europe/Warsaw` zone, relative time for recent ledger
  entries and a full absolute timestamp in `<time>` details. UTC ISO timestamps
  remain the data protocol and are not rewritten before API submission.
- Isolated browser E2E, authorization-role matrix, and real workloads are
  broader #399 Definition of Done work; no production mutation is permitted.
