# Equipment API (SV-006)

Equipment queries and commands behind the SV-005 authorization boundary, using the SV-001 contracts in `packages/domain/contracts.js`. Every request runs inside one `authorization.run()` transaction, so equipment, audit and private command receipts commit together or not at all. SV-023 adds operator replay and repairs location-change lock waits without changing the public record or response keys.

```js
import {createAuthorization} from '../auth/index.mjs';
import {createEquipmentHandler} from './routes.mjs';
const handler = createEquipmentHandler({authorization: createAuthorization({identityProvider, pool}));
http.createServer(handler).listen(port);   // mounts the routes below; anything else is 404
```

| Request | Permission | Result |
| --- | --- | --- |
| `GET /organizations/:org/equipment?limit&cursor&status&location&q` | inventory:read | `{items, nextCursor}`, ordered by asset ID. `limit` 1 to 100 (default 25). `q` matches name or ID, wildcards are literal. |
| `GET /organizations/:org/equipment/:id` | inventory:read | The contract record, or 404. |
| `PATCH /organizations/:org/equipment/:id` | equipment:write | Body `{expectedVersion, status?, note?}`, header `Idempotency-Key`. 200 with `{record, changed, replayed}`; 409 `version_conflict` (with `current`); 422 disallowed transition; 400 bad input. |
| `POST /organizations/:org/equipment/:id/observations` | equipment:write | Body `{locationId, observedAt, source}`, header `Idempotency-Key`. 201 if it moved the verified location, 200 with `applied:false` and a reason if it was older or a duplicate. |

`id` is the stable external asset ID and `locationId` the stable location key. The actor is the authenticated user, never a body field; `receivedAt` is set by the server. Unknown body fields, wrong content type and bodies over 16 KB are rejected. Callers are authenticated before the body is read.

## Guarantees

- **Version-checked:** commands lock only tenant-scoped equipment first, then read the joined record in a fresh statement snapshot. Use PostgreSQL's default **READ COMMITTED** isolation. This avoids a joined `FOR UPDATE OF e` recheck dropping a valid equipment row when a blocking transaction changes its location. Receipt lookup follows the lock and precedes version validation, so overlapping identical retries replay rather than fail on the just-committed version. Status rules come from the SV-001 contract and the SV-004 database trigger.
- **Atomic audit and receipts:** a changed PATCH inserts an event and a receipt in the equipment transaction. A successful no-op (including `{expectedVersion}` alone) inserts a receipt but no event, and does not change equipment/version/freshness. Failed audit or receipt inserts roll back all writes. Plain inserts and tenant-wide unique keys safely reject hidden cross-actor receipts or another target using the same key.
- **Status edits never refresh location confidence;** observations never change status or version, and an older observation is recorded as history but cannot move an item backward.
- **Tenant-scoped:** queries filter on the organization from the route (checked against the login's membership) and row-level security backs that up.

## PATCH replay

`equipment_command_receipt` stores the normalized request and the complete original successful response, including location, last verified source/time, administrative timestamp, note presence and provenance. It is append-only with FORCE RLS. Runtime grants are only SELECT and INSERT; its policies expose only the verified actor's own receipts while that actor still has `equipment:write` in the verified tenant. Membership, role and identity revocation still deny replay. General audit policies/grants remain unchanged; an operator's direct `equipment_event` SELECT still returns no rows.

Keys are scoped to a tenant and the existing `admin:` command namespace. Receipt identity includes the equipment UUID and verified actor. Request normalization ignores JSON member order but preserves exact string values, expected version, and optional-field presence: omitting `note` differs from supplying `note:""`, and omitting `status` differs from explicitly supplying the same status. Invalid field values are rejected before lookup. Reusing a key for another request/actor/target returns 409 (either `idempotency_key_reused` or a stale `version_conflict`); unauthorized tenant access is denied. The same key can identify independent authorized commands in different tenants, and never exposes another tenant's snapshot.

A replay returns **the original `record`**, even after later administrative edits or observations, with the existing `changed:false, replayed:true` flags and `Idempotent-Replay: true` header. The original stored response retains its first-attempt flags. Replay writes no equipment, event or receipt. Clients should refetch current authoritative state after a command/replay instead of treating an old replay snapshot as the latest record.

`X-Correlation-Id` is a transport trace, **not** part of command identity. The first successful attempt's correlation ID is stored in its receipt and event (receipt only for a no-op). A retry may carry a new correlation ID, but does not rewrite the original trace or create a second event. HTTP headers trim surrounding whitespace as before; body strings are not trimmed.

## Migration and legacy keys

Apply `migrations/0001_receipts.up.sql` **after core and auth**, in a single maintenance transaction with old equipment writers stopped. Do not run mixed old/new equipment binaries: old writers do not create receipts. The migration backfills only **key reservations** for existing `admin:` audit keys; it does not reconstruct snapshots from incomplete historical `after_state`. Legacy reservations have no actor, request or result, are hidden by RLS, and conflict on insertion even for a new no-op. A legacy retry with an old version may instead receive `version_conflict`. Fetch current equipment and use a new key/version for a new intentional edit. Pre-migration successful no-ops left no event/key, so they cannot be recovered or reserved retroactively.

The maintenance connection must already have full visibility of historical audit rows. `SET LOCAL row_security = off` makes a filtered backfill fail rather than silently omit legacy keys; the migration grants no privilege and changes no audit policy. Keep the transaction around the entire script. The task-local runner uses `psql` from `PG_BIN` (including Windows `psql.exe`) or PATH:

```sh
node services/api/equipment/migrate.mjs up
# Uses the existing DATABASE_URL maintenance connection.
```

Grant **SELECT, INSERT ON public.equipment_command_receipt** to the existing non-owner, NOBYPASSRLS runtime role using the deployment's normal grant procedure; there are no PUBLIC grants or new credentials. Do not grant UPDATE/DELETE. Down migration drops only this table and destroys its replay history, including no-op key reservations. Stop writers and retain a database backup before intentionally rolling back the schema; returning to old code also returns its retry limitations.

## Verification

```sh
npm ci --prefix services/api/equipment --ignore-scripts
npm run test:native --prefix services/api/equipment
node --test services/api/equipment/tests/equipment.test.mjs
npm test
npm run check
```

The native suite uses pinned test-only `embedded-postgres@18.6.0-beta.19` binaries and `pg@8.23.1`. It starts a disposable loopback cluster with a per-run password in memory, creates no OS account or persistent service, and shuts down/removes its cluster. Missing package symlinks are rehydrated locally. Windows requires an execution environment that permits PostgreSQL's temporary WAL file renames. Alternatively set `EQUIPMENT_TEST_DATABASE_URL` to an explicitly disposable local PostgreSQL cluster on which the fixture may create/drop its own randomly named database and NOLOGIN runtime role. No hosted/production database should be used. Linux root environments should supply an already-running local fixture rather than enabling automatic OS-user creation.

Native tests use separate physical sessions and `pg_blocking_pids` barriers (not timing-only sleeps): same-key replay, same-version winner, cross-target key collision rollback, EQ-002 observation A to room-103/B newer to room-104, and PATCH behind a location change. Additional checks cover original snapshots after later edits/observations, operator audit restriction, normalized/omitted fields, actor/tenant isolation, no-op receipts, membership/permission/identity revocation, legacy reservations, immutable receipt security and injected receipt-write rollback.

The pre-existing serial suite uses PGlite installed under auth; without it ten database cases explicitly skip and the record-mapping case still runs. Its existing forced-RLS seed/bootstrap setup and the root auth dependency/test-loader repair belong to SV-019. This task does not modify those files or claim that the native equipment fixture (which loads synthetic fixtures before auth) validates that bootstrap. See [SV-023 verification evidence](VERIFICATION.md) for actual final outcomes and skips.

## Limits

- `INSERT ... ON CONFLICT` cannot be used on `equipment_event` for roles without `audit:read`, so plain inserts are used.
- Observation duplicate-key response semantics remain the SV-006 contract (`applied:false, reason:'duplicate-idempotency-key'`); PATCH receipts do not change observation idempotency behavior.
- No equipment create or delete endpoints, and no audit-log read endpoint (SV-012).
