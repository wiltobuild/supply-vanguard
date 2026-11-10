# Replenishment (SV-010)

Mountable API and task-local migrations, after the existing core, auth and supply ledger. No production server, identity provider, credentials, persistent grants, operational threshold defaults, or external notification channels are installed. All changes stay in `services/api/replenishment` and `apps/web/supplies`.

## Domain behavior

- A bin is low only when its current ledger quantity is **strictly less** than its latest configured par quantity, in its immutable SKU unit. No configured par means `low_par: null`, not healthy or low. Configuration accepts explicit, versioned, nonnegative decimal strings. Zero is allowed and means an explicitly configured zero par, never an implicit default.
- `detect` checks one authorized bin. One active task per tenant/bin is enforced by a partial unique index. That task is the in-app alert; repeated checks retain its identity and emit no additional detection event. No scheduler or outbound message delivery is implied. A new low-stock episode can create a new task only after the previous one is completed.
- Existing `inventory:read`, `supplies:write`, and `audit:read` permissions are reused unchanged. A supply writer can assign an open task **to themselves**. Only its current assignee, still authorized to write supplies, can complete it. There is no delegation, reassignment, escalation, extra role, or administrator exception in this workflow.
- Completion records **actual received quantity**, not an invented target or automatically calculated refill. Positive quantity appends a `restock` transaction to the existing supply ledger. Explicit `0` closure requires a reason and writes an audit event without a zero-delta ledger row. Closing work does not assert the bin reached par. Assigned/open tasks remain queued if another stock edit recovers the bin, with current `low_par: false` visible. Staff can close with zero and an explanation.
- A count correction takes an absolute `countedQuantity` and expected ledger version, computes an exact signed delta with BigInt, and appends an existing `adjustment` ledger entry. No conversion between boxes/each/ml occurs. An unchanged count is an audited confirmation with no balance/version change. Originals are never rewritten.
- Detection retains its original quantity and par version. Later configuration is appended and audited; queue reads display the latest configured par and current stock. Old detection evidence remains intact.

## Atomicity, retries, isolation

Every mutation runs in the existing `authorization.run()` transaction, using only its verified tenant and actor. Locks are acquired in a fixed order: tenant/key advisory transaction lock, then tenant/bin advisory transaction lock. A fresh receipt lookup after the key lock returns an immutable original response on matching replay, including after intervening stock or task changes. The normalized operation, bin/task, versions, quantities, source, reason, correlation ID and verified actor bind the key. Changed payload or another actor returns 409. Authorization is checked again before replay; revocation denies it. Keys are tenant-scoped, never cross-tenant receipts.

Distinct completions serialize on the bin, lock the task, and verify its expected version and assignee. Once completed it cannot complete again. The ledger's original optimistic version/quantity predicate and unique constraints also protect against writers outside this module, which do not acquire these advisory locks. Competing external ledger writes may return a conflict; there is no automatic stale retry. Ledger, balance projection, task, immutable event and receipt commit or roll back together. Generated ledger keys are private per accepted command, with the immutable public command receipt retaining the result.

All four new tables have FORCE RLS and tenant composite foreign keys. Audit/config/receipt records are append-only; task detection metadata and terminal state are guarded. Existing supply ledger and auth policies/grants are unchanged. Runtime is a non-owner, NOSUPERUSER, NOBYPASSRLS role. The database login remains a trusted application boundary, consistent with existing modules.

**Verification limit:** the task-local suite uses PGlite and serialized connection leases. It executes real SQL, RLS, triggers and rollback, but is not native PostgreSQL multi-session or lock-wait proof. Native same-key, competing-key completion, external-ledger collision, and rollback/wait interleavings remain a review gate in an authorized disposable environment. Prior native/loopback denials were not retried here.

## Setup contract (not executed against an operational database)

```sh
npm ci --prefix services/api/replenishment --workspaces=false --ignore-scripts
# Apply documented core/auth/supplies first, using an authorized local setup connection.
node services/api/replenishment/migrate.mjs up
```

The runner requires `DATABASE_URL`, wraps migration in a transaction/advisory lock, and safely no-ops if already in the desired state. Its owner needs schema CREATE and REFERENCES on organization, auth_user and supply_bin. Migrations create no users, credentials or grants. Existing runtime privileges for auth, inventory and ledger remain necessary. An integration owner must explicitly provision the following **additional** least-privilege grants for their already-approved runtime role; this task has not done so outside the disposable in-memory fixture:

```sql
GRANT SELECT ON public.replenishment_par, public.replenishment_task,
  public.replenishment_event, public.replenishment_receipt TO sv_runtime;
GRANT INSERT ON public.replenishment_par, public.replenishment_task,
  public.replenishment_event, public.replenishment_receipt TO sv_runtime;
GRANT UPDATE(status,assignee_id,version,completed_at) ON public.replenishment_task TO sv_runtime;
```

Do not grant DELETE/TRUNCATE or general UPDATE. Stock balances still require no runtime write grants. `migrate.mjs down` drops only new replenishment history/tasks/config/receipts and the guard function, preserving supply ledger/core/auth. It is destructive to that task-local history; do not run against retained operational data without a separately approved retention/restore procedure. Reapply creates empty tables.

## Mounting contract and HTTP

```js
import {createReplenishment} from './services/api/replenishment/service.mjs';
import {createReplenishmentHandler} from './services/api/replenishment/http.mjs';
const replenishment = createReplenishment({authorization}); // existing verified authorization
const handler = createReplenishmentHandler({replenishment});
// The host routes /organizations/:organizationId/replenishment/* to handler(req,res).
```

Host owns identity verification, origin/CSRF protections for its chosen auth transport, listener, error logging and operational routing. Do not trust an organization ID as membership proof or add test identity headers to a real host. Responses are JSON/no-store. Bodies are capped at 16 KiB; lists have bounded UUID keyset pagination (`after`, `limit` 1–100, default 50), returning `{items,nextCursor}`. `bins` also returns `canWrite` from the existing permission map. Paging is a live view, not an export snapshot, and UUID order is not event chronology.

GET routes:

- `/organizations/:organizationId/replenishment/bins`
- `/organizations/:organizationId/replenishment/tasks` (active only)
- `/organizations/:organizationId/replenishment/history?binId=:binId` (`audit:read`)

POST routes are `/configure`, `/detect`, `/assign`, `/complete`, `/correct` under the same prefix. Each body includes `{binId,idempotencyKey,reason,source,correlationId?}`. Additional fields:

| Command | Additional input |
| --- | --- |
| configure | `parQuantity` decimal string, `expectedPolicyVersion` integer (`0` when absent) |
| detect | none |
| assign | `taskId`, `expectedTaskVersion` integer |
| complete | `taskId`, `expectedTaskVersion`, `expectedStockVersion`, `receivedQuantity` decimal string |
| correct | `expectedStockVersion`, `countedQuantity` decimal string |

New accepted commands return 201; identical original receipts return 200 with `replayed: true`. Versions are mandatory for mutations affecting an existing projection. Malformed inputs are 400, unknown authorized bin/task 404, stale versions/changed-key requests 409, and auth 401/403. Unexpected SQL errors are hidden. No client-supplied actor/role is used.

## Verification

```sh
npm test --prefix services/api/replenishment --workspaces=false
npm test
npm run check
```

Run the task-local suite explicitly: existing root discovery/CI does **not** include it, and CI configuration is outside this task's scope. See [VERIFICATION.md](VERIFICATION.md) for exact evidence, failures, skips, browser denial, and integration gaps. Test quantities, identities, thresholds, grants and preview data are explicitly synthetic/test-only.
