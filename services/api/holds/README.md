# Independent stacked equipment holds (SV-021)

A hold is a flag on an asset. Four kinds exist (`dirty`, `fault`, `maintenance`, `unknown`) and they stack independently: an asset can carry all four at once. While any hold is active the asset cannot be assigned. A hold is cleared only by the role the organization configured for that kind. The product ships with **no role names and no administrator exception**: with no rule configured, nobody can clear that kind.

Apply `0001_holds.up.sql` after core (SV-004), auth (SV-005) and requests (SV-020); undo with `0001_holds.down.sql`. Same hand-applied lifecycle as the other service migrations.

| Request | Permission | Result |
| --- | --- | --- |
| `GET /organizations/:org/equipment/:id/holds?state=all\|active\|cleared` | inventory:read | `{equipmentId, summary, holds}`. `summary` is `{blocked, activeKinds, active, total}`. |
| `POST /organizations/:org/equipment/:id/holds` body `{kind, reason?}` | equipment:write | 201 with the hold. Repeating an active kind is 200 with `Idempotent-Replay`: kinds do not stack twice. |
| `POST /organizations/:org/holds/:holdId/clear` | any member; the database decides | 200, or 403 `wrong_role`, 404, 409 `hold_already_cleared`, 422 `no_clearance_rule`. |
| `GET /organizations/:org/holds/clearance-rules` | inventory:read | The role configured for each kind, or `null`. |
| `PUT /organizations/:org/holds/clearance-rules/:kind` body `{role}` | organization:manage | Sets the role for a kind. Roles must be one of the existing SV-005 roles. |

## How it is enforced

- **Role to clear:** `public.clear_equipment_hold()` reads the caller's role from their own active membership (never from the request) and compares it with the rule for the hold's kind. Row-level security on `equipment_hold` repeats the same check for direct SQL, so a wrong role cannot clear a hold even without the function. An admin has no special right: the admin clears a kind only if the admin role is the one configured for it.
- **Blocking assignment:** a `BEFORE INSERT` trigger on `item_assignment` refuses (`sv:equipment_on_hold`) when any active hold exists on the asset. It lives where assignments are written, so it holds even if the claim function is bypassed. The claim API reports it as 422 `equipment_on_hold`. This is the one integration with SV-020: a line added to `CLAIM_ERRORS` in `packages/domain/requests/index.js`.
- **Hold against claim:** `place_equipment_hold()` locks the asset as the claim function does. Whichever commits first wins: a claim waiting on a hold that commits is refused; a hold waiting on a claim that commits is placed and the claim stands. An uncommitted hold blocks nothing.
- **History:** hold rows are never deleted. Clearing flips `active` and records who and when; a trigger refuses any other change.
- **A hold never changes the asset:** status and version are untouched (the SV-004 trigger ties version moves to real status edits).

## Decisions to review

- **Who clears what is configuration, not code.** I did not guess which role clears which kind. The PRD diagram's role names (coordinator, environmental services, biomed) are not in the SV-005 role set, and the task says not to invent roles. An admin sets the mapping, and tests use a fixture mapping (dirty to supply manager, fault and maintenance to equipment manager, unknown to admin) that is clearly labelled as such.
- **Placing a hold needs `equipment:write`** (operators, equipment managers, admins). Placing is not restricted by kind.
- **Reading holds needs only `inventory:read`**, like requests and assignments.
- **Existing assignments are not touched by a new hold.** Holds block new assignment; what happens to something already assigned belongs to SV-022.
- **No UI** and no way to remove a rule once set (change it to another role instead).

## Tests

`npm test` runs `tests/holds.test.mjs`: domain rules, HTTP and row-level security tests on PGlite (skip if it is not installed), then `hold-race.native.test.mjs` on real PostgreSQL (skips if it is not installed) with one `psql` session per actor and a lock-based interleaving, no sleeps. Mutation checks: removing the blocking trigger fails both the PGlite and the native tests; skipping the role check in the function, or loosening the row-level security, each fail the role tests. Removing the explicit asset lock in `place_equipment_hold()` did not change the native result, because the foreign key to `equipment` already takes a conflicting row lock; the explicit lock stays to keep the lock order the same as the claim function.
