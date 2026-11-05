# SV-008 verification evidence

Base: main `75f2cf60a645aa9a40363b9836b3830047d77ca5` (includes merged PR #8 and #10). Isolated branch: `task/sv-008-wil-sol-sv008-20261105-f28c`. Normal CLI claim confirmed at board revision 78; lease file retained in this checkout. Only the two task-owned check-in directories are changed.

## Completed checks (2026-11-05)

- `npm test --prefix services/api/check-in`: 24 cases, **23 passed, 1 explicitly skipped** after focused retry rework. Eleven API/SQL cases run the real handler, existing `createAuthorization`, `recordObservation`, `applyObservation`, core/auth/check-in SQL migrations and RLS in serialized PGlite. Twelve DOM/scanner cases use jsdom and controlled scanner/media interfaces. No test substitutes a fake equipment/domain adapter for the SQL path.
- API evidence: manual/QR/barcode sources; exact equipment identity and synthetic provenance; user-derived actor and server-derived received time; known tenant locations; unknown ID, invalid/future/date/payload data; exact original-result replay after later location and administrative edits; location/time/source/target/correlation changed-key conflicts; cross-actor/tenant isolation; inactive membership/user replay rejection; operator audit SELECT remains empty; old observations retained without location rollback; injected event and receipt failures roll back state/history/receipt together; repeated same-key and competing changed-key/actor requests create one observation.
- The simultaneous PGlite request cases are **serialized database coverage**, not proof of native overlapping transactions. The separate native lock-wait case skips explicitly in default mode.
- UI evidence: manual entry without camera APIs; explicit confirmation and scanner Enter handling; associated labels, inline error/ARIA state and text-only rendering; repeated unchanged submissions; network interruption and cancellation; stable retry key/payload/time; 401/403/404/409 feedback; explicit camera start, permission denial, safe QR parsing, track cleanup, stop while permission is pending. Mobile wrapping, 44px controls and focus styling are source/CSS checks.
- `npm run check`: passed JavaScript syntax, **12 GLB** containers and 19 seed task definitions. Existing NICU assets and shared code remain unchanged.
- `git diff --check`: passed.

## Root suite and environment limits

`npm test` was run and failed: **23 passed, 2 failed, 16 skipped** (41 total). The auth loader cannot resolve `@electric-sql/pglite` from the untouched auth package. The board-race test's temporary Git repository failed to write `config` with Windows `Permission denied`. Existing core database tests skip because their upstream native detection does not find PostgreSQL; existing equipment suites skip because the auth-local dependency is absent. This task does not modify those reserved root/auth/native-detection files, or recreate/transfer the publication-blocked SV-019 artifact.

The first explicit native check-in test attempt failed during `initdb`: Windows denied renaming `pg_wal/xlogtemp...` to its WAL segment in the sandbox temporary directory. No native suite passed in this Windows checkout. The first loopback HTTP attempt failed `connect EACCES 127.0.0.1:<ephemeral port>`. Both operations were stopped; neither was retried through escalation, a different identity, a different directory, or an alternate execution route. Current default tests use independent in-process HTTP streams and PGlite SQL; actual network/native behavior remains unverified here. A deterministic independent-session native lock-wait test is included for an authorized environment.

Real browser visual layout, tab traversal, narrow-screen rendering, live camera hardware, permission dialogs and existing 3D regression flows were **not run**. The integration module is not mounted in the existing app because PR #13 owns its shared entry/client files. No camera permission was accepted, screenshots saved/uploaded, production credentials persisted, hardware/hosted service provisioned, or upstream general equipment concurrency repair claimed.

## Integration still required

PR #13/shared-entry owners must mount the web module with their existing authenticated transport and refetch callback, register the API handler in the existing dispatcher, and coordinate application of the task-local receipt migration plus grants to the existing runtime role. The minimal hooks are documented in both check-in READMEs. Do not merge or deploy until that coordination and unrun native/browser stages have been reviewed. This submission is a draft for review only.

## Focused retry rework

Independent review of head `ea5029774c06f838a42ea00e92811e463a446e6c` found that a camera rescan compared raw `SV1:EQ-001` form text with normalized `EQ-001` and cleared the attempt before submission could compare normalized fields. Board rework was recorded at revision 85 under the designated reviewer label, then the original owner reclaimed SV-008 at revision 86 in this retained checkout.

The camera callback now updates the fields without clearing the attempt; the existing normalized equipment/location/source comparison at submission remains the sole decision for changing an attempt. Two deterministic DOM/scanner regressions failed on the reviewed code: a successful prefixed QR submission followed by the equivalent camera rescan made a second POST, and an interrupted-response rescan replaced its retry key. Both now pass. A third regression confirms that a changed equipment target still creates a new key only after confirmation. No API, SQL, actor/tenant, authorization, time, migration or shared code was changed for this rework.

The parent supplied additional independent verification of the **previous exact head** `ea5029774c06f838a42ea00e92811e463a446e6c`: Linux PostgreSQL 16.15 with real loopback HTTP passed all 21 then-existing tests with zero skips. This is attributed review evidence for that head, not a Windows native pass or native verification of the changed head. The retained Windows native/HTTP permission stops were not retried. The previous root suite failures remain applicable; the denied board-race Git write was not retried during this narrow UI rework. The final scoped suite and root syntax/asset check were rerun. Browser/camera hardware and application mounting remain unverified.
