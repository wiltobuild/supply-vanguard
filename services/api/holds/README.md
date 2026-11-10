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

# Clearance evidence (SV-031)

Clearing a hold can now record **evidence**: a reference and an observed time that the clearer supplies. Evidence is a **recorded assertion**. Nothing here says it is enough to clear a hold, and no role, threshold or administrator exception is invented. Whether a kind of hold needs evidence, and what counts as enough, is an open owner decision (see below).

## Contract (version 1)

New command, alongside the original `/clear` route (which is unchanged):

```
POST /organizations/:org/holds/:holdId/clearances
Idempotency-Key: <1-88 chars: letters, digits, . _ : ->        (required)
Content-Type: application/json
{ "schemaVersion": 1,
  "evidence": { "reference": "Cleaning log #12",              (required, 1-128 chars: letters, digits, space, . _ : # / -; starts with a letter or digit)
                "observedAt": "2026-11-10T09:30:00Z",         (required, UTC, a real date, not in the future, at most millisecond precision: .123Z)
                "note": "wiped and dried" } }                 (optional, up to 500 characters, single line, no control characters)
```

Permission and role are exactly the original rule: any member reaches the route, and the database allows only a member whose role is the one the organization configured for the hold's kind. Unknown fields are refused with fixed text that never repeats what was sent, so `actor`, `organizationId`, `role`, `clearedBy`, `clearedAt` and `recordedBy` cannot be supplied.

| Result | When |
| --- | --- |
| 201 | Cleared. Body `{hold, replayed:false, summaryBasis:"current", summary, holds}` where `summary` and `holds` list the equipment's remaining active holds. |
| 200 + `Idempotent-Replay: true` | Exact retry of an earlier success by a caller who **still holds the current configured role**: the original cleared hold and evidence, nothing stored twice (`replayed:true`). Otherwise the retry gets the same 403 `wrong_role` or 422 `no_clearance_rule` a first attempt would (see SV-033 below). |
| 400 `invalid_request` | Missing or malformed evidence, body or `Idempotency-Key`, including an `observedAt` finer than a millisecond. Nothing is stored. |
| 422 `evidence_invalid` | Only if malformed evidence somehow reaches the database: the database re-checks the same rules. Nothing is stored. |
| 403 `wrong_role` / 422 `no_clearance_rule` | Same as the original clear. Nothing is stored. |
| 404 `hold_not_found` | Unknown hold, or a hold of another tenant. |
| 409 `hold_already_cleared` | The hold is already cleared (by either route). No second evidence is stored. |
| 409 `idempotency_conflict` | The key was used with a different payload or hold, or by someone else. The same answer in every case, so a caller learns nothing about other people's keys. |

**The hold in responses** (both routes, and the list) gains `clearance`: `null` while active; `{basis:"evidence-v1", evidence:{id, schemaVersion, reference, observedAt, note, recordedBy, recordedAt}}` when cleared with evidence; `{basis:"legacy-no-additional-evidence", evidence:null}` when cleared the original way. A legacy clearance's actor and time, and a hold's placement `reason`, are never presented as evidence. Existing clients keep working: nothing was removed or renamed.

**Who and when.** The actor is the authenticated user and the time is the database clock, taken inside the database function. They cannot come from the request, headers or body. `observedAt` is only the clearer's claim about when they observed the item.

**Untrusted text.** `reference` is restricted to a safe character set. `note` is bounded single-line free text, stored and returned verbatim as a JSON string. Clients must render it as text (never as HTML).

**Retries.** The request hash covers the hold, the reference, the observed instant (to the millisecond) and the note, so the same instant spelled differently (`.5Z` and `.500Z`) is the same request, and two different instants never are. Receipts are visible only to their own actor (row-level security), which is what keeps conflicts private.

## Migration (additive)

`migrations/0002_hold_clearance_evidence.up.sql` (undo with `.down.sql`) after `0001_holds`. It does not rewrite 0001 and does not touch `clear_equipment_hold()` or the `equipment_hold` triggers. It adds `hold_clearance_evidence` (one row per cleared hold), `hold_clearance_receipt`, append-only triggers on both, row-level security, and `clear_equipment_hold_with_evidence()`.

- **Order:** apply 0002, then 0003 (see SV-033 below), before deploying this service code, because hold queries now read the evidence table. Rolling either back is safe for 0001 data.
- **Runtime privileges (as with the other service migrations, nothing is granted here):** `SELECT, INSERT` on both new tables (no `UPDATE` or `DELETE`) and `EXECUTE` on the new function.
- **Atomic:** the clearance, the evidence row and the receipt are written by one function call, so a failure at any step leaves the hold active and stores nothing.

## SV-033 repairs (evidence contract, still version 1)

Independent review of the first version (source `5f2f30c`) found two real gaps and one contract gap. They are fixed without rewriting the shipped 0002.

1. **A replay must pass the current role check.** The first version returned a stored receipt before checking the caller's role, so someone whose role had since been downgraded, or after the organization changed or removed the rule for that kind, could still get a success response by repeating the old request. Nothing new was ever written, but the answer was wrong. Now a replay is allowed only while the caller still holds the **current** configured role for that hold's kind: otherwise 403 `wrong_role` (also for a changed payload under a lost role) or 422 `no_clearance_rule`. A revoked or inactive membership still fails at authorization before any of this (403). Receipt privacy and the 409 `idempotency_conflict` behavior for other actors are unchanged, and a replay still writes nothing.
2. **`observedAt` precision is milliseconds.** The first version accepted six fractional digits and then lost them in JavaScript: `.123001Z` and `.123999Z` became one request with one hash, and `.000999Z` passed a present-time boundary of `.000Z`. Now finer input is refused with 400 instead of truncated. **Compatibility:** a client that sent more than three fractional digits must send at most three. This ships before any UI wiring, so no known client is affected. Only the spelling of an instant may vary (`.5Z` equals `.500Z`).
3. **What a replay returns.** The cleared `hold` and its `clearance.evidence` in a replay are exactly the original. `summary` and `holds` are the **current** stack for that equipment when the response is made, so they can differ from the first response if another hold has since been placed or cleared. The response now says so with `summaryBasis:"current"` on both 201 and replay. Consumers must not treat the whole response as immutable receipt history. Only `hold` is the receipt.

**Migration 0003** (`0003_hold_evidence_replay_role.up/down.sql`) replaces `clear_equipment_hold_with_evidence()` (same signature, so existing `EXECUTE` grants stay in force; `down` restores the 0002 body). Apply it after 0002. The first-clearance path, grants, row-level security, append-only records, authenticated actor and time, and the stacked-hold and assignment guards are unchanged. No role, evidence policy or administrator exception was added.

**Tests:** the new regressions fail on `5f2f30c` and pass now (3 failing on the original). `node --test services/api/holds/tests/evidence.test.mjs services/api/holds/tests/holds.test.mjs` runs 25 tests on PGlite with none skipped: the replay cases (role downgrade, rule change, rule removed, revoked membership, no extra writes, original outcome untouched), precision at and around the boundary, the current-stack contract, and 0003 up/down. They are still outside root `npm test`.

## Decisions still open (not made here)

- **Is evidence required, and when?** Today the legacy `/clear` still works without evidence. Making evidence mandatory, retiring `/clear`, and any cutover for existing clients are owner decisions. Until then no claim of "all clearances have evidence" is true.
- **What is sufficient evidence** for each kind of hold, and who may vouch for it. This code records what was supplied and decides nothing.
- **Retention** of evidence and receipts.

## Handoff for the UI (SV-027)

Use the request, response and `clearance` shapes above. The UI must send an `Idempotency-Key` per clearing attempt (reuse the same key to retry the same attempt), show `clearance.basis`, and render `reference` and `note` as text. It must not present a legacy clearance as having evidence.

## Tests for SV-031

`node --test services/api/holds/tests/evidence.test.mjs` (domain rules plus HTTP and SQL on PGlite) and `holds.test.mjs` (the original tests, now run with 0002 applied, proving legacy clients still work). They are not yet in the root `npm test` (`tests/holds.test.mjs` imports only the original two files); adding one import there is a later root change outside this task.

**Not run (explicit gates; unchanged by SV-033):** PGlite is a single session, so these were **not** exercised: concurrent clearing of one hold with the same or different keys (the per-hold advisory lock is untested under real concurrency), a clear racing a claim or a new hold on native PostgreSQL, behavior with multiple pooled connections, and the migration on a populated production-like database. A native opt-in test for these needs native database setup that this task did not use.
