# SV-023 verification

Base: fresh main `149f62a26e3fba004b1f5ac776c64b4193b9e8f0` (already-merged SV-006 PR #8). Claimed through the live board at revision 61 by `wil / wil-vale-sv023-20261105-receipts-a81f`; no competing SV-023 claim existed. Work is confined to `services/api/equipment`.

Environment: Windows x64, Node.js **24.18.0**, native **PostgreSQL 18.6** (`x86_64-windows`, `msvc-19.44.35228`), driver **pg 8.23.1**, pinned binary wrapper **embedded-postgres 18.6.0-beta.19**. Local ephemeral fixture only; no hosted database, OS account or persistent service. The fixture SQL loads synthetic data before installing auth; it does not validate or repair SV-019's post-auth seed/bootstrap.

| Command | Actual result |
| --- | --- |
| `npm install --prefix services/api/equipment --ignore-scripts` | Pinned equipment-only dependencies installed; 0 reported vulnerabilities. Root/auth package and lock files unchanged. |
| `npm run test:native --prefix services/api/equipment` | **13 passed, 0 failed, 0 skipped** on separate native PostgreSQL sessions. |
| `node --test services/api/equipment/tests/equipment.test.mjs` | **1 passed, 0 failed, 10 skipped**: PGlite absent from the existing auth dependency location. No serial concurrency claim. |
| `npm test` | **24 passed, 1 failed, 16 skipped**. Failure is the upstream root auth loader's `ERR_MODULE_NOT_FOUND` for `@electric-sql/pglite`. Six shared database cases skip because their existing helper cannot find its supported PostgreSQL/psql install; ten equipment PGlite cases skip. |
| `npm run check` | Passed: JavaScript syntax, **12 GLB containers**, existing 19 seed task definitions. Seed count is not the live board. |
| `git diff --check` | Passed. |

The final root test run ran outside the file sandbox so the local Git board-race fixture could create its temporary bare repository; that test passed. An earlier sandbox-only root attempt additionally failed its temporary Git config write. Similarly, native initdb initially could not rename a temporary WAL file inside the sandbox; the authorized disposable native cluster was then run outside that filesystem restriction. Neither failure changed the application or caused a policy/grant workaround.

## Native acceptance evidence

- Operator's exact retry returns the **complete first response record** after a manager changes its note and another observation changes its location. `changed:false`, `replayed:true` and the existing replay header are preserved. Equipment version and counts of events, observations and receipts do not change on retry.
- The operator's direct `SELECT * FROM equipment_event` returns **zero rows**, while its own receipt is visible. Audit table policies and grants are untouched by the implementation.
- Reordered JSON members replay. Changed expected version/status/note, omitted optional members, a different verified actor or equipment target conflict. A shared principal in two tenants receives only each tenant's own snapshot; an actor lacking membership is denied. Key uniqueness remains tenant-scoped.
- Successful explicit no-op and expected-version-only commands create private receipts without equipment/version/event changes; their original snapshots replay after a later edit. Hidden cross-actor no-op key collisions also conflict.
- Membership deactivation, downgrade to viewer and identity deactivation each deny replay; restoring authorization allows it again.
- Real separate-session waits are confirmed using **`pg_blocking_pids`** before the blocking transaction is released: identical same-key requests yield one write plus a successful replay; distinct-key/same-version requests yield exactly one winner; cross-target reuse rolls the losing equipment update/event back.
- Deterministic **EQ-002** observation A changes room-101 to **room-103** and pauses before COMMIT. Newer observation B to **room-104** is proven blocked, then succeeds after A commits. Both observations/events exist; B's event starts at room-103, ends at room-104, and retains its `qr` source and timestamp, with administrative version unchanged.
- PATCH waiting behind a location-changing observation also succeeds with the freshly joined room and preserves verified location/source/time.
- An audit unique-key collision rolls back an equipment edit. An injected receipt INSERT failure rolls back equipment and its already-inserted audit event. The cross-target native key race separately proves uniqueness-induced rollback.
- Migration SQL backfills a legacy audit key as a hidden reservation with **NULL request/result/actor**, without fabricating a snapshot. Both changed and no-op legacy reuse conflict, leaving version/event counts unchanged.
- Native tests verify FORCE RLS, append-only triggers, absence of runtime UPDATE/DELETE privilege, actor spoof rejection, and tenant-equipment foreign keys.

The two lock-wait tests were also tried with only the old joined-lock load temporarily reinstated: both reported failure. That diagnostic wrapper timed out during shutdown before printing detailed failure summaries, so it is not counted as a successful suite run. A `finally` block restored the final service byte-for-byte (SHA-256 `6407f513c10342bed4b5d1d9e9426b9f8c878b170be6704fd2ea7f1527ec5760`); inspection found no surviving task fixture `postmaster.pid` files. The final native passing run uses the repaired service.

## Remaining limits

The native suite applies the task migration SQL transactionally; this embedded binary distribution has no `psql`, so the `psql` CLI migration wrapper itself is syntax-checked but not executed here. Review can rerun the native suite against an existing disposable PostgreSQL 16 cluster through `EQUIPMENT_TEST_DATABASE_URL`; no PostgreSQL 16 result is claimed from this Windows run.

The root clean-install/auth loader and forced-RLS seed issue remain reserved to SV-019. Shared auth/core-db/bootstrap/root dependency/test-loader/workflow files were not changed, and its blocked Library artifact was not used. The older PGlite suite remains skipped here rather than being reported green.

Legacy audit keys have no recoverable full snapshot and return a safe 409; historical successful no-ops left no keys to reserve. Migration requires stopped old writers and a maintenance connection already able to read all legacy events. Receipt read/insert grants must be added only for the deployment's existing least-privilege runtime role. See [README](README.md) for migration, correlation-ID and rollback semantics. No deployment, approval, merge or task completion is part of this change.
