# Native hold-evidence concurrency acceptance harness (SV-034)

A **source-only, opt-in, inert** harness for the race and authorization cases that the PGlite tests (`evidence.test.mjs`) cannot show, because PGlite is a single session. It exists so a **future supervised runner** can prove them against a real, isolated, synthetic PostgreSQL. **Nothing here has been run against a database**, and writing it does not authorize running it.

## What was and was not run

| | Status |
|---|---|
| Pure tests of the harness itself (fake child process, an in-memory model of the database, a fake clock): `node --test services/api/holds/tests/evidence-native.test.mjs` | run: 40 pass, 1 skipped (SV-036: 9 new tests) |
| Mutation inventory of the harness: `node services/api/holds/tests/native-evidence-mutations.mjs` | run: 87 entries, 86 caught, 1 survives by design (overlapping layer; the combined entry is caught) |
| The seven native cases against real PostgreSQL | **NOT RUN** |
| Any SQL, database, role, grant, listener, download, install or credential step | **NOT RUN, not authorized** |

The in-memory model (`native-evidence/fake-world.mjs`) reproduces only the behaviour the cases look at. It tests the **harness** (orchestration, outcome checks, cleanup, failure handling). It proves nothing about PostgreSQL or the migrations. A harness that passes against the model has not been shown to pass against the database.

## Why it cannot connect by accident

- Importing or running the pure tests never spawns a process, opens a connection or reads a database setting from the environment, even on a machine with PostgreSQL installed. The only module that imports `child_process` is `native-evidence/psql-spawn.mjs`, and the suite reaches it only through a dynamic import **after** an explicit, scoped opt-in contract has validated. A test enforces this.
- The one opt-in channel is the variable `SV_HOLD_EVIDENCE_NATIVE_CONFIG`, naming an absolute path to a contract file. Nothing else is read from the environment. If it is absent, the native test is reported as **skipped** (never passed).
- Session processes get an environment built from scratch (`PGPASSFILE`, a session name, a timeout, `LC_ALL`, `PGSSLMODE`, and statement/lock/idle limits) and `-w`, so nothing the calling process has set (service, host, user, password, connection string) can influence the target and psql can never prompt.
- The old `hold-race.native.test.mjs` (automatic cluster and role provisioning) is **not imported or executed**; it was read as text only. It also predates migrations 0002 and 0003, so it never touches the evidence function.

## The contract the supervised runner supplies

A JSON file; `parseContract` rejects anything else. Secret-looking fields (`password`, `token`, `connectionString`, ...) are refused outright, and errors name a field path, never a value.

```json
{
  "optIn": {"approved": true, "scope": "sv-034-hold-evidence-native", "runMarker": "svrun-<8-32 lowercase letters/digits>"},
  "runtime": {
    "psqlPath": "/absolute/path/to/psql (matching the server)",
    "host": "127.0.0.1", "port": 54329,
    "database": "sv_<runMarker with - replaced by _>",
    "runtimeRole": "<non-privileged runtime role>",
    "passfile": "/absolute/path/to/a runner-owned passfile (its contents are never read here)",
    "expected": {"serverVersionPrefix": "16.", "databaseOwner": "<owner role, different from the runtime role>"},
    "deadlineMs": 120000
  },
  "fixture": {
    "organizations": {"a": "<uuid>", "b": "<uuid>"},
    "actors": {
      "clearerA":  {"userId": "<uuid>", "organization": "a", "role": "<the role configured to clear 'fault' and 'maintenance'>"},
      "clearerA2": {"userId": "<uuid>", "organization": "a", "role": "<same role as clearerA>"},
      "operator":  {"userId": "<uuid>", "organization": "a", "role": "operator"},
      "outsider":  {"userId": "<uuid>", "organization": "b", "role": "<any role>"}
    },
    "rules": {"dirty": "<role>", "fault": "<clearerA's role>", "maintenance": "<clearerA's role>", "unknown": "<role>"},
    "holds": [{"id": "<uuid>", "kind": "fault", "equipmentId": "<external id>"}],
    "requests": [{"requestId": "<uuid>", "line": 1, "equipmentId": "<external id>"}],
    "control": "external-runner-v1"
  }
}
```

Rules the contract enforces: loopback host only; the database name is **bound to the run marker**; the passfile and psql paths are absolute and traversal-free; the runtime role is not a default superuser name and differs from the database owner; the two clearers share a role and the outsider is in the other organization; at most 64 holds and 16 requests.

**The fixture is fictional and provisioned by the runner.** Each case consumes **distinct** items, so the pool must contain at least: 8 active `fault` holds each on its own equipment with **no** request (plain), one **pair** (an active `fault` and an active `maintenance` hold on the same equipment) with one open request line for that equipment, and one **single** (one active hold on its own equipment) with one open request line. Evidence and receipt rows are append-only, so every run consumes its items; the runner owns removal of the database, roles and everything else.

## Fixture control (privileged setup stays with the runner)

The harness never holds bootstrap credentials or elevated permissions. For the cases that change the **configured** role or rule between a first clear and its replay, the runner supplies a `control.apply(action)` object (resolving to `{ok: true, proof}`) for exactly these bounded, fictional actions, validated before they are sent:

`set-rule {kind, role}` · `remove-rule {kind}` · `set-membership-role {actor, role}` · `set-membership-active {actor, active}` · `restore {scope: "case" | "all"}`

`actor` is one of the four fixture actors only. The harness always asks for `restore {scope: "all"}` after a case that used control, and a refusal, error or doubt makes that case **UNCERTAIN**. Without a control the control case is **NOT RUN** (`fixture_control_unavailable`) and the receipt is **INCOMPLETE**.

## How the supervised runner calls it

The convenience path in the test file has no control, so it can only end INCOMPLETE. The runner should call the exported API directly:

```js
import {parseContract} from './native-evidence/contract.mjs';
import {createPsqlSessionFactory} from './native-evidence/session.mjs';
import {runAcceptance,redactedReceipt} from './native-evidence/runner.mjs';
import {realSpawn,realNonce,realClock} from './native-evidence/psql-spawn.mjs';   // the only module that spawns

const contract = parseContract(JSON.parse(await readFile(contractPath, 'utf8')));
const factory  = createPsqlSessionFactory({contract, spawn: realSpawn, clock: realClock, newNonce: realNonce});
const receipt  = await runAcceptance({contract, factory, control: runnerOwnedControl, clock: realClock});
console.log(JSON.stringify(redactedReceipt(receipt, contract)));      // receipt.accepted is true only if everything required passed
```

## What runs, in order

1. **Preflight (read-only, fail closed).** If any check fails, every case is NOT RUN. It verifies the exact database, runtime role, loopback server and version prefix; the runtime role has no superuser, BYPASSRLS, role-creation, database-creation or replication attribute, owns nothing protected and is a member of no owner role; the database owner matches; row-level security is **enabled and forced** on the protected tables (and `auth_user` is enabled but **not forced**: its resolver is the intentional exception); the evidence function is the corrected 0003 invoker function and the others are invokers; the runtime role has **exactly SELECT and INSERT** on the evidence and receipt tables and EXECUTE on the function; and the supplied tenants, actors (active membership with the configured role), rules, holds and open request lines are what the contract says.
2. **Seven cases**, each with fresh, owned psql sessions, one statement at a time, with the per-hold advisory lock held inside an **open** transaction until the next session is **observed waiting** on it (via `pg_stat_activity`, as the same role, with no extra grants). No sleep decides an outcome.

| Case | What it proves |
|---|---|
| `sameKeyReplay` | Two real sessions, same actor, key and payload: the second waits, then replays; exactly one clearance, one evidence row, one receipt; evidence and receipts cannot be updated or deleted by the runtime role. |
| `differentKeyCompetingClear` | Two clearers race with different keys: exactly one clearance; the loser gets `hold_already_cleared` and writes nothing. |
| `clearVersusClaimStackedAndNewHolds` | While a clear is uncommitted, a new independent hold is placed and a claim is refused (`equipment_on_hold`); after commit the other hold still blocks; clearing the **last** hold lets exactly one claim succeed, and only after the commit. |
| `rollbackInterleavings` | When the holder rolls back, the waiter becomes the first clear and the rolled-back evidence does not survive; a raised error (evidence from the future) leaves no trace. |
| `roleOrRuleChangeBeforeReplay` | After the runner changes the configured rule, removes it, downgrades the member's role or deactivates the membership, the replay is refused (`wrong_role`, `no_clearance_rule`, `wrong_role`, `hold_not_found`) with no extra rows; after restore it replays again. |
| `actorPrivateConflict` | Another actor's key is invisible and answered as `idempotency_conflict`; on the cleared hold they learn nothing about the key; the owner's replay still works. |
| `tenantDenial` | A clearer of the hold's own tenant first clears it with evidence, and that populated record and its receipt are confirmed in full. Then a user of the other organization cannot clear it (own tenant or by naming the other), cannot read the evidence, receipt or hold, and the record is unchanged. An empty hold is not isolation proof. |

Final summaries (active hold kinds) are asserted as **current state**, not as part of the receipt. No hold policy, role or evidence-sufficiency rule is invented.

## Outcomes, deadlines and cleanup

- One **external deadline** (`runtime.deadlineMs`) bounds everything, on an injected clock. Waits are bounded polls of 25 ms inside that deadline; there are no unbounded sleeps.
- Output per statement is finite (200 rows, 16 KB) and error text is redacted; receipts carry **codes and counts only** (no SQL, paths, host, database, role, run marker or secret).
- Statuses per case: `PASS`, `FAIL` (a wrong outcome), `NOT RUN` (a precondition was missing; nothing was started), `UNCERTAIN` (a timeout, a dying session, an unexpected error, or a cleanup that could not be confirmed). **Only a PASS counts.**
- `accepted` is true only if the preflight passed, **every** required case passed (and no extra case failed), and cleanup is certain. A skip, an INCOMPLETE run, an UNCERTAIN case or any doubt is **never** an acceptance claim.
- Cleanup is unconditional and per case: roll back any open transaction (releasing its advisory lock), close **only the handles this run opened** (ask psql to quit, then SIGTERM, then SIGKILL on the owned child; never a PID lookup and never a server-side backend termination), and ask the runner to restore anything it changed. Handles that could not be confirmed closed are reported and make cleanup uncertain. Removing the database, roles and other resources remains the runner's job.

## Not covered

- Everything native (the seven cases, the preflight against a real server, the `psql` framing against a real `psql`) is **unrun**.
- `waitQueued` (observing the waiting session) matters only against a real database; the in-memory model cannot show its removal, so it is the one deliberate hole in the mutation inventory.
- The root `npm test` still does not import the evidence tests; wiring them (and any CI use of this harness) is a separate, coordinated integration obligation.
- Frozen request-lifecycle (SV-022) and ops (SV-017) harnesses are separate dependencies and were not touched.

## SV-036 repairs (source only, still nothing run against a database)
Seven defects found by independent review of the SV-034 harness, each reproduced first with fakes and now covered by a failing-before / passing-after test:
1. **Deadline admission:** an expired deadline spawns nothing and writes no SQL, including statements queued behind an expired one.
2. **Stream errors:** stdin, stdout, stderr and the child have error listeners for the whole session life, including after cleanup was requested. A fault rejects pending work, is recorded as a fixed code only, and makes the run unacceptable (`receipt.cleanup.faults`).
3. **Process error is not exit:** only an exit or close event (or a recorded exit code or signal) counts as the process being gone. A sent kill or an error event does not.
4. **Verifier start-up failure:** every handle the factory still owns is closed and accounted for on every path. An unresponsive handle keeps `cleanup.certain` false.
5. **Tenant denial** needs populated evidence (see above).
6. **Persisted record:** every case that clears something compares the stored schema version, reference, observed time, note, tenant, hold, recording actor and evidence identity, and the receipt's link, actor and request hash with the exact prepared request.
7. **Preflight:** the owner of each of the four protected functions is read from the catalog and must not be the runtime role, and the runtime role must not be a member of any owner role (database, schema, tables or functions). Nothing is granted. The `auth_user` exception is unchanged.

Fixture note: nothing new is required of the runner. `tenantDenial` still consumes one plain `fault` hold. The in-memory model is still only a model of the harness.
