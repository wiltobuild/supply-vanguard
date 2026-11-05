# Supply ledger (SV-009)

Consumables use SKUs with a declared unit and bins tied to existing tenant locations. They never create serialized equipment rows. A SKU's unit and a bin's SKU/location are immutable; use a new SKU/bin for a different unit or physical mapping. There is no implicit conversion between packs, boxes, each or milliliters. Quantities are exact decimal **strings**, up to 12 whole digits and 3 fractional digits. Zero balance is valid; negative stock is rejected.

## Local setup and migration

Requires Node 22+, the existing core and auth migrations, and a local PostgreSQL database. No hosted account or production credential is needed. From repository root:

```sh
npm ci --prefix services/api/supplies --workspaces=false --ignore-scripts
# Apply core/auth using their documented setup first. Set DATABASE_URL to your local setup connection.
node services/api/supplies/migrate.mjs up
```

The task-local runner uses the pinned `pg` driver, a migration advisory lock and one transaction. Repeating up/down is a no-op when already in that state. It does not alter core/auth migrations or seed data. Use a setup role with schema CREATE and REFERENCES on organization, location and auth_user. A non-superuser supplies owner also needs SELECT on auth_user/auth_membership so the existing auth permission function can evaluate the trigger's FORCE RLS policies. Migrations create no roles or credentials.

Keep the existing auth runtime role non-owner, NOSUPERUSER and NOBYPASSRLS. In addition to its existing auth/core read permissions, grant only:

```sql
-- Replace sv_runtime with the existing runtime role; execute as the supplies table owner.
GRANT SELECT ON public.supply_sku, public.supply_bin, public.supply_bin_stock,
  public.supply_stock_transaction TO sv_runtime;
GRANT INSERT ON public.supply_sku, public.supply_bin, public.supply_stock_transaction TO sv_runtime;
```

Do not grant runtime INSERT/UPDATE/DELETE/TRUNCATE on balances or UPDATE/DELETE/TRUNCATE on ledger, SKU or bin tables. The narrow SECURITY DEFINER triggers maintain zero initialization and balance projection; they have fixed search paths and no PUBLIC execute permission. FORCE RLS uses the unchanged auth context and permission helpers. Ledger writes also require the actor to match the authenticated user. Table ownership and setup privileges remain trusted administrative boundaries, as in the existing core.

Rollback, after exporting any stock history that must be retained:

```sh
node services/api/supplies/migrate.mjs down
```

Down permanently removes supply rows and functions, preserving core/auth. Do it before rolling back auth/core and while supply traffic is stopped. Up recreates empty supplies tables; it cannot recover deleted history. The integration test verifies down/up.

## API integration

Construct `createSupplies({authorization})` from `index.mjs` using the existing `createAuthorization` instance. Its methods run inside that module's verified membership transaction: `createSku`, `createBin`, `listSkus`, `listBins`, `postStock`, `history`. Reads require inventory:read; stock/SKU/bin creation requires supplies:write; history requires audit:read. Existing supply_manager/admin roles can write, viewers/operators cannot. No client actor or role is trusted.

Mount `createSuppliesHandler({supplies})` from `http.mjs` in a host Node HTTP server. This is a mountable API, not a new server or production identity provider. Routes:

- GET/POST `/organizations/:organizationId/supplies/skus`
- GET/POST `/organizations/:organizationId/supplies/bins`
- POST `/organizations/:organizationId/supplies/transactions`
- GET `/organizations/:organizationId/supplies/bins/:binId/history`

Lists use `after` UUID and `limit` (1–100, default 50), ordered by UUID. History includes per-bin sequential versions for ordering and reconciliation. Pagination is a live view, not an export snapshot. JSON responses are no-store; malformed/oversized JSON is rejected and unexpected SQL errors are hidden.

SKU input: `{code, name, unit}` with a lowercase unit token, e.g. `each`, `box`, `ml`. Bin input: `{code, skuId, locationId}`. New bins start at quantity `0.000`, version `0`. Stock input:

```json
{"binId":"00000000-0000-4000-8000-000000000001","kind":"restock","delta":"12.5","expectedVersion":0,"idempotencyKey":"restock-work-123","reason":"Synthetic restock","source":"manual","correlationId":"work-123"}
```

Use `adjustment` for signed corrections; restocks must be positive. The server supplies actor, timestamps, before/after quantity and next version. Success returns the immutable transaction (HTTP 201); identical retries return the original ID and `replayed: true` (HTTP 200), including after later balance edits. Reusing a tenant-scoped key with changed bin/delta/version/actor/source/reason/correlation returns 409. Keep the key stable across transport retries. A genuine new operation uses a new key.

The AFTER INSERT trigger atomically updates balance with a version-and-before-quantity predicate. PostgreSQL locks/rechecks the row; unique tenant/bin/version and tenant/idempotency constraints prevent two ledger entries at the same version or double-applied retries. A stale competing request returns 409 `stock_conflict`; refetch the bin, reconcile the intended operation, and explicitly retry against the new version. No automatic stale-write retry is performed. The ledger insert and balance update commit or roll back together. Corrections append a new transaction, never rewrite history.

## Verification

```sh
npm test --prefix services/api/supplies --workspaces=false
npm test
npm run check
```

Supply tests fail rather than silently skip if their native PostgreSQL fixture cannot start. Pinned embedded-postgres 18.4 provides throwaway local binaries; the fixture uses a random password, a loopback listener and a verified temporary directory, creates no OS users/services, stops the process and removes its own directory. It uses real separate SQL connections, not PGlite or a serialized fake pool. The Windows filesystem sandbox may block PostgreSQL WAL renames; run this fixture in the authorized desktop execution context if needed. On Linux use a regular non-root user; automatic OS-user creation is disabled.

Coverage: 16 synchronized identical requests commit one ledger row; distinct requests racing one version produce one winner/one 409 and an explicit retry preserves both deltas; pg_stat_activity confirms lock waiting; transaction rollback restores both history and balance; exact fractional units, negative-stock and forged-before-state rejection; non-superuser schema/trigger owner; runtime RLS/FKs/actor/role isolation; immutability; HTTP through real auth/SQL; migration down/up. Root tests do not discover this task-local suite yet, so run it explicitly. The separate SV-019 owner is repairing root clean-install/auth bootstrap behavior; this task does not change those files.
