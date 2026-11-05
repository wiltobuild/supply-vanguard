# SV-017 validation record

## Resumed repair on current main

Reviewer rework was independently confirmed at live revision 148. Original-owner reclaim exited
0 at revision **149**, agent `wil-sol-sv017-20261105-ops`, owner `wil`, on the same checkout/branch.
Heartbeat before integration succeeded at revision 150. A normal non-force merge integrated
main `9113df98c2601820f7a13c471b9d4c226458654c` as merge commit
`70a39d453a5b9cc81d5253ebbbe03b540a7b2c7c`, with no conflicts or hand edits to shared files.
All authored repair changes remain under `ops/`. SV-019 root/auth/core/bootstrap/CI ownership
and all source migrations remain untouched.

| Repair command/check | Actual result |
| --- | --- |
| `node --test ops/tests/*.test.mjs` | Exit 0: 15 passed, 0 failed, 0 skipped |
| `node ops/recovery-inventory.mjs` | Exit 0: all 7 current service migrations discovered and hashed; 24 expected public tables |
| `npm run check` | Exit 0: JavaScript syntax, 27 GLBs and 19 seed task definitions validated |
| Root suites excluding the previously denied board-race fixture, command below | Exit 1: 83 tests, 46 passed, 1 failed, 36 skipped. Auth import still lacks `@electric-sql/pglite`; no dependency repair/install performed |
| Native client discovery (`findTools()` from `ops/recovery-drill.mjs`) | Exit 1: `psql`, `pg_dump`, `pg_restore` unavailable. No native connection or SQL execution |
| `git diff --check` | Exit 0 |

The resumed root verification used:

```powershell
$taskRootTests = Get-ChildItem tests -File -Filter '*.test.mjs' |
  Where-Object { $_.Name -ne 'board-race.test.mjs' } |
  Select-Object -ExpandProperty FullName
node --test @taskRootTests
```

This does not claim a new full `npm test` pass. The previously denied board-race Git operation
was excluded, rather than rerun in another directory/identity/execution route. The original full
command result and exact denied target remain in the historical record below. The 36 current
skips comprise missing PGlite coverage (audit/equipment/requests), core native DB and native
request-race coverage. The independent auth-local import failure belongs to SV-019.

The repair uses unchanged equipment receipt, supply, request and location-resolution migrations,
including actual legacy-key backfill. Synthetic fixtures now cover all 24 tables. Focused tests
reject matching-but-incomplete inventories, changed replay actor/key/response links, fractional
ledger/projection mismatches, broken assignments/events, override partner/policy/expiry changes,
cross-tenant evidence and weakened source RLS/index metadata. Snapshots additionally compare
all indexes and function ownership/ACL/security settings. These are source/logic regressions;
the new SQL fixtures and native post-restore assertions are **unrun**, not a restore pass.

Native prerequisites remain missing: there is no `psql`/`pg_dump`/`pg_restore` on PATH and no
supplied `PG_BIN`, `OPS_PGHOST`, `OPS_PGPORT` or existing `OPS_PGUSER` configuration. No approved
marked disposable cluster was supplied or verified. No clients/cluster/credentials/grants were
installed, started or created, and no previous native/filesystem denial was bypassed.
[RECOVERY.md](RECOVERY.md#run-the-real-drill) contains the reproducible manual command for
an owner-provided existing marked loopback cluster. Native backup/restore, SQL fixture execution,
native cleanup, runtime-role authorization, hosted recovery and rollback remain unproven.

## Initial submission (historical, before the repair)

Baseline: main `5e1100cae690f001fa4964bb73f52479598f6e75`, isolated branch
`task/sv-017-wil-sol-sv017-20261105-ops`. Normal claim exited 0 at live board revision 99
on 2026-11-05; lease retained in this checkout's ignored `.claims/SV-017.json`.
Only `ops/` is implementation scope. Workflow/root dependencies/auth/core DB/app/domain/scene
changes are excluded. PRs #9, #11, #12, #13 and #14 were open at initial inspection and were not
treated as merged contracts in this baseline. Remote main subsequently advanced to
`6eebdad5d94e1ecf28b9137885fc996836647ff7` (SV-020, PR #11); the parent thread also reported
merged PRs #9/#12. Merge/rebase sequencing belongs to the separate PR manager; this isolated
branch remains based on `5e1100ca` and changes no shared service contracts.

Environment: Windows desktop, Node v24.18.0, npm 11.16.0. No provider service, production data,
credential/grant, persistent access, alert delivery, hosted deployment or merge was created.

| Command/check | Actual result |
| --- | --- |
| `node --test ops/tests/*.test.mjs` | Final run: exit 0, 8 passed, 0 failed, 0 skipped; local logic only, no native database |
| `node --check ops/recovery-drill.mjs` | Exit 0 after the final cleanup guard change |
| `node ops/environment.mjs --profile demo` | Exit 0; Node prerequisite satisfied |
| `node ops/environment.mjs --profile integration` | Exit 1; missing auth PGlite, ingestion `pg` and `embedded-postgres` in this clean clone; no installation/fix made |
| `node ops/monitor.mjs --input ops/examples/telemetry.synthetic.json` | `unknown` for all five signals because the example sample is stale; expected fail-closed result, not live monitoring evidence |
| Recovery preflight below | Exit 1; PostgreSQL `psql`, `pg_dump`, `pg_restore` unavailable. No connection, database, archive or restore was attempted |
| `npm test` | Exit 1: 41 tests, 23 passed, 2 failed, 16 skipped. Auth import fails for missing `@electric-sql/pglite`; board-race Git fixture receives filesystem permission denial. Six native DB tests and ten equipment tests skip for missing PostgreSQL/PGlite |
| `npm run check` | Exit 0: JavaScript syntax, 12 original GLB containers and 19 seed task definitions validated |
| `git diff --check` | Exit 0; no whitespace errors |

The board-race failure was Git exit 128 trying to write
`C:/Users/Wil/AppData/Local/Packages/sandbox.{268a9c61-cef9-41cc-92ca-3894c30dfade}/AC/Temp/vanguard-race-luF0NC/remote.git/config`:
`Permission denied; could not set core.repositoryformatversion to 0`. This fixture failed;
it was not rerun through another identity, directory or route. Reading the parent message history
provided no new authorization to retry it. This was a filesystem denial inside the test, not an
automatic approval-review rejection. The requested root test command finished; no root repair
or substitute passing run is claimed.

Recovery invocation used process-local `OPS_PGHOST=127.0.0.1`, `OPS_PGPORT=55439`, and the
placeholder `OPS_PGUSER=existing_owner_required`, followed by
`node ops/recovery-drill.mjs --confirm-disposable-synthetic`. The failure occurred during tool
discovery before any use of that placeholder identity. Exact diagnostic:

> PostgreSQL psql, pg_dump and pg_restore unavailable; install matching PostgreSQL 16+ client tools in an approved environment and set PG_BIN

The real disposable native backup/restore exercise is **unproven**. The script's integrity
comparison tests are not substituted for it. [RECOVERY.md](RECOVERY.md#run-the-real-drill)
contains the reproducible command and prerequisites for an owner-approved existing marked local
cluster. This task did not install PostgreSQL, provision identities/grants, reuse the ingestion
bootstrap's temporary credentials, bypass existing native/loopback permission stops or change
RLS/auth policy. Missing auth-local setup remains SV-019's independent work; its blocked Library
artifact was not copied, reconstructed or transferred.

At initial submission the fixture loaded only core/auth/ingestion migrations. The resumed repair
above extends source coverage to every currently merged service migration. Any future release
still requires reconciling the explicit inventory and fixtures; actual native execution remains
a separate unmet gate.

## Remaining operational gates

Choose provider/region/residency, actual primary and backup owners, managed OIDC/source adapters,
the assembled production service/health boundaries, reviewed existing runtime access, secret
manager/rotation procedure, log/journal retention, metrics collector/alert route, approved
freshness thresholds and staffing. Complete a real disposable restore, hosted recovery and
rollback rehearsal, measured recovery targets and synthetic end-to-end authorization/readiness
checks. CI wiring remains with SV-019. Real hardware integration, measured architectural
accuracy and ward/production sign-off remain separate gates. These runbooks establish no SLO.
