# Equipment API (SV-006)

Equipment queries and commands behind the SV-005 authorization boundary, using the SV-001 contracts in `packages/domain/contracts.js`. Every request runs inside one `authorization.run()` transaction, so a change and its audit event commit together or not at all.

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

`id` is the stable external asset ID and `locationId` the stable location key. The actor is the authenticated user, never a body field; `receivedAt` is set by the server. Optional `X-Correlation-Id` is stored on the audit event. Unknown body fields, wrong content type and bodies over 16 KB are rejected. Callers are authenticated before the body is read.

## Guarantees

- **Version-checked:** the row is locked (`FOR UPDATE`), the expected version is compared, and a mismatch is a 409 that changes nothing. Status rules come from the SV-001 contract and the SV-004 database trigger.
- **Atomic audit:** the equipment update and its `equipment_event` row share a transaction. A reused idempotency key raises a unique violation and rolls back both.
- **Status edits never refresh location confidence;** observations never change status or version, and an older observation is recorded as history but cannot move an item backward.
- **Tenant-scoped:** queries filter on the organization from the route (checked against the login's membership) and row-level security backs that up.

## Limits

- **Retries:** a repeated `PATCH` returns the original result only for roles that can read the audit log (equipment manager, supply manager, admin). Under the SV-005 policies an operator cannot read `equipment_event`, so an operator's retry gets a normal 409 and nothing is applied twice. A narrow read policy for the caller's own events would fix this.
- **Concurrency tests run on PGlite,** which has one connection, so competing requests are serialized rather than truly parallel. The row lock and the check are exercised, but not parallel sessions. Re-run against real PostgreSQL once a connection driver (`pg`) is chosen.
- `INSERT ... ON CONFLICT` cannot be used on `equipment_event` for roles without `audit:read`, so plain inserts are used.
- No equipment create or delete endpoints, and no audit-log read endpoint (SV-012).
