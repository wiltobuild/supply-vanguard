# Requests and atomic item assignment (SV-020)

A request holds several items (each asks for a type of equipment). A coordinator claims a specific asset for an item. When two coordinators claim the same asset at once, exactly one wins. The request summary (`open`, `partially-assigned`, `assigned`) is derived from the item states and never stored.

Apply after core (SV-004) and auth (SV-005): `0001_requests.up.sql`, undo with `0001_requests.down.sql`. Same lifecycle as `services/api/auth`: run the SQL with your existing local database URL.

| Request | Permission | Result |
| --- | --- | --- |
| `POST /organizations/:org/requests` body `{note?, items:[{equipmentType}]}` | equipment:write | 201 with the request. 1 to 20 items, unknown types rejected. |
| `GET /organizations/:org/requests?limit&cursor` | inventory:read | `{items, nextCursor}`, oldest first, keyset pagination. |
| `GET /organizations/:org/requests/:id` | inventory:read | The request with its items, assignments and derived summary. |
| `POST /organizations/:org/requests/:id/items/:line/claim` body `{equipmentId, expectedVersion}` | equipment:write | 201 on a new claim, 200 with `Idempotent-Replay` for a retry. 404, 409 or 422 with a stable `error` code. |

Claim errors: `equipment_not_found`, `item_not_found` (404); `item_already_assigned`, `stale_version`, `equipment_already_assigned` (409); `wrong_equipment_type`, `not_assignable` (422).

## How the claim stays atomic

`public.claim_request_item()` is one database function. In a single transaction it locks the asset (`FOR UPDATE`), then the item (always in that order, so claims cannot deadlock), and checks: the item is still open, the asset has the right type, the asset version equals `expectedVersion`, the asset is `available`, and no other active assignment exists. A partial unique index (one active assignment per asset, one per item) is the backstop if anything bypasses the function. Each claim also writes an append-only `request_event`. The function runs with the caller's rights (not SECURITY DEFINER), so SV-005 row-level security and permissions still apply, and tenant context comes from the SV-005 session settings.

## Decisions to review

- **A claim is provisional.** It does not change the asset's status or version: the SV-004 trigger only lets the version move with a real status or note edit. So the loser of a race gets `equipment_already_assigned`, and `stale_version` means the asset itself was edited after the caller read it.
- **Assignable means `available`.** Anything else (in use, cleaning, maintenance, retired) is `not_assignable`. Holds that block assignment are SV-021, and releasing or cancelling an assignment is SV-022.
- **Permissions reuse the existing matrix:** `equipment:write` to create requests and claim, `inventory:read` to read. No new roles were invented; PRD role names are not verified.
- **Retries:** repeating the same claim by the same user returns the original assignment. A different user or asset gets `item_already_assigned`.

## Tests

`npm test` runs `tests/requests.test.mjs`: domain rules, then HTTP and row-level security tests on PGlite (skip if it is not installed), then `claim-race.native.test.mjs` on real PostgreSQL (skips if it is not installed). The native test starts a throwaway cluster and uses separate `psql` sessions with a lock-based interleaving, not sleeps: a third session holds an advisory lock, session A claims and waits on it while holding the asset, session B starts and is observed waiting on A, then A commits (B loses) or rolls back (B wins). It also checks a stale version loses.

## Limits

No release, cancel, hold or return handling (SV-021, SV-022); no UI. A claim does not change asset status, so other code that reads only `equipment.status` will not see it as assigned yet.
