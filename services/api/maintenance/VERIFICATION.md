# SV-011 verification receipt

2026-11-06 UTC, Windows / Node 24.18.0. Base main: `94d2f97978ee0e0d13dbfe1918785111481e7058` (still remote main before publication).

Claim confirmed with CLI exit 0 at live board revision **173**, owner `wil`, agent `wil-sol-sv011-20261106-maintenance`; pre-edit heartbeat confirmed at revision **175**. Only `apps/web/maintenance` and `services/api/maintenance` are changed.

| Check | Observed result |
| --- | --- |
| `npm test --prefix services/api/maintenance` | **18 passed, 0 failed, 0 skipped**, exit 0. Actual authorization/RLS, two tenants, status guards, history cursor, same-key replay/collision, version conflict, audit rollback, assignment filtering, DOM drafts/uncertainty, cache revocation and an in-process web→API→SQL→audit→refetch flow. |
| `node apps/web/maintenance/tests/browser-check.mjs` | **Passed**, exit 0. Installed Chrome offline; native Tab/Enter service save and retained focus, history, 1440px desktop and 390px narrow, reduced-motion context, no horizontal overflow, zero axe WCAG A/AA violations. Initial narrow select overflow was fixed before this passing run. |
| `npm run check` | **Passed**, exit 0; JavaScript syntax, **27 GLBs** and 19 seed task definitions validated. |
| `npm test` | **46 passed, 2 failed, 36 skipped**, exit 1. Both failures are existing setup/environment paths below. The scoped suite is intentionally not added to the reserved shared root loader/CI. |
| `git diff --check` | Passed. |

Root failures/denial:

1. `tests/auth.test.mjs`: `ERR_MODULE_NOT_FOUND`, auth-local `@electric-sql/pglite` is not installed in this fresh checkout. Task-local dependencies are isolated under maintenance. Shared auth/bootstrap/dependency/loader repairs are reserved to SV-019 and were not installed, modified or reconstructed here.
2. `tests/board-race.test.mjs`: `git init --bare` could not write `C:/Users/Wil/AppData/Local/Packages/sandbox.{4c69f8c1-4e78-4cc6-99e3-4d6df471aca9}/AC/Temp/vanguard-race-SVsw3w/remote.git/config`: **Permission denied**, Git exit 128. The fixture did not complete; its claim race was not executed. This denied operation was stopped and not retried in another directory, identity or worker. No live board mutation came from the fixture.

The 36 root skips comprise missing auth-local PGlite and native PostgreSQL prerequisites. Native PostgreSQL multi-session races, real loopback HTTP hosting, shared-app navigation, live auth bootstrap and manual screen-reader checks are **unrun**. No denied native/loopback operation was attempted again. Embedded concurrent commands are serialized and are not native lock-interleaving proof.

Screenshots: [desktop](../../../apps/web/maintenance/evidence/desktop.png), [390px narrow](../../../apps/web/maintenance/evidence/narrow.png). They show an **offline synthetic adapter**, not mounted shared-app reachability.

Remaining decisions: the exact independent-hold/matching-role clearance policy belongs to SV-021. Service completion therefore preserves unavailable status. Shared static/API mounting and shared available-search adoption require coordinator handoff; the existing shared status-only search is unchanged. There is no deployment, merge or completion claim in this receipt. PR head, exact-head hosted CI and board submission receipt are reported in the draft PR/task handoff.

## Review rework — 2026-11-06 UTC

[Manager review](https://github.com/wiltobuild/supply-vanguard/pull/22#pullrequestreview-5794633966) reproduced a rejected read touching removed DOM after close, and non-JSON403 losing its HTTP status before cache cleanup. Normal original-owner reclaim confirmed exit 0 at live board **182**, `2026-11-06T01:43:49.189Z`; pre-edit heartbeat confirmed at **183**. Same checkout, branch and draft PR #22, unchanged scope.

The adapter now classifies HTTP denial before parsing success JSON and preserves status on unreadable successful responses. The panel checks root ownership, lifecycle and request generations on success/error/finalization. Close/remount/access loss invalidates obsolete reads/writes/history, including late errors; current errors still show. Authorization-sensitive state/cursors are cleared on inventory/write denial or session expiry; history-only403 clears audit history without widening audit permission or discarding separately permitted inventory. Genuine uncertain writes still retain exact command/key and refetch after accepted replay.

| Rework check | Observed result |
| --- | --- |
| Initial regression run before production fixes | **20 of 29 tests failed**, including the removed-DOM exception, non-JSON401/403 status loss, stale cached data and obsolete lifecycle writes. Controls for current errors and genuine uncertain retry passed. |
| `npm test --prefix services/api/maintenance` | **51 passed, 0 failed, 0 skipped**, exit 0: original18 plus33 lifecycle/status regressions. Includes explicit deferred401/403/500 after close, identity remount, newer history/selection, global expiry versus other in-flight work, delayed writes, HTML/empty/malformed/JSON denials, and unchanged key/body for network/unreadable200/500/503 retries. Actual auth/RLS/service/history/pagination/receipt/rollback fixtures remain passing. |
| `node apps/web/maintenance/tests/browser-check.mjs` | **Passed**, exit 0. Actual adapter and domain validator bundled into an offline Chrome page: HTML/empty401/403 clear cached equipment/draft/history; late401/403/500 after close produce zero page errors/unhandled rejections. Existing keyboard/focus, desktop/390px, reduced-motion and axe checks also pass. No HTTP listener or mounted runtime claim. |
| Permitted repository subset | **38 passed, 0 failed, 0 skipped**, exit 0. Command: `node --test tests/additional-assets.test.mjs tests/contracts.test.mjs tests/domain.test.mjs tests/glb-equivalence.test.mjs tests/location.test.mjs tests/scene-config.test.mjs tests/web.test.mjs`. No socket/native/temp-Git fixture runs. |
| `npm run check` | **Passed**, exit 0; syntax,27GLBs and19seed definitions. |
| `git diff --check` | Passed. |

The full root `npm test` was **not rerun**: it would repeat the specifically denied temporary Git operation recorded above. Its earlier46pass/2fail/36skip receipt is historical, not a result for the rework. No prior-denied native/loopback stage was retried or rerouted. Shared mounted reachability, real HTTP service hosting, native multi-session concurrency and manual screen-reader checks remain unrun. This rework changes no API/service policy, SQL, hold clearance, shared files or reserved infrastructure.

## Current-main holds compatibility — 2026-11-09

Coordinator handoff permitted **local code only**, with the existing public-push stop intact. Original identity reclaimed SV-011 normally at board **196**, `2026-11-09T14:36:33.576Z`; pre-edit heartbeat confirmed at **197**. Latest main `afe17ebc52c125ae1e3d1d95881a5b294e9dee16` merged cleanly on the same branch via local merge `8c29202592b79b1a572bf74fa3f685c41250682f`, preserving unpublished UI repair `d8147c177533b6e8b2a3e5afa640f061aa9ffd65`. Current instructions make separate review optional; they do not override publication, scope, testing or claim restrictions.

The ready SQL now adds a tenant/equipment-correlated `NOT EXISTS` on **any active `equipment_hold` before pagination**, alongside available status and no active assignment. The fixture applies the actual merged SV-021 migration and grants only ephemeral SELECT on holds. Synthetic fixture history uses its trusted in-memory owner; it introduces no runtime clearance role, new policy, hold mutation grant or production provisioning. Service completion and replay preserve every hold and remain unavailable. The panel/runbook describe the unheld requirement and the real migration/read-privilege prerequisites. Missing holds schema or read permission fails closed with generic500 and no ready records, without an older-schema fallback.

| Check | Observed result |
| --- | --- |
| New hold-query suite before SQL fix | **7 failed,1 passed**, reproducing available/version0 EQ-1 appearing despite an active dirty hold, and missing pre-pagination/hold prerequisites. |
| `node --test services/api/maintenance/tests/holds-ready.test.mjs` after SQL fix | **8 passed,0 failed,0 skipped**, exit0. All four kinds/all existing inventory roles; stacked/partially cleared/all-cleared history; limit1 pages past active holds/assignments; tenant-isolated same external IDs; service/replay preserving holds; missing read privilege/schema failing closed. |
| `npm test --prefix services/api/maintenance` | **59 passed,0 failed,0 skipped**, exit0. Retained UI lifecycle/HTTP-denial regressions and actual auth/RLS/audit/receipt/hold fixtures all pass on the integrated branch. |
| Permitted repository subset, same explicit seven-file command above | **40 passed,0 failed,0 skipped**, exit0. The current-main optional-review tests account for the count change from38. |
| Offline Chrome browser command | **Passed**, exit0. Actual-adapter HTML/empty401/403 cache cleanup and late rejection after close; native keyboard/focus, desktop/390px, reduced motion, zero horizontal overflow and zero axe WCAG A/AA violations. Refreshed synthetic screenshots visually inspected. This is still an offline module fixture, not mounted HTTP. |
| `npm run check` | **Passed**, exit0; syntax,27GLBs and19seed task definitions. |
| `git diff --check` | Passed. |

Full root `npm test`, native PostgreSQL, loopback hosting and previously denied Git fixtures were not retried. No shared/held web paths, SV-019 reservations, root dependency/CI, operational roles or hold policy were authored here; incoming main was integrated unchanged. Mounted-app integration remains coordinator-owned. No push, alternate publication route or PR submission is authorized or attempted for this local repair. The exact retained commit and blocked-board receipt are reported in the task handoff; there is no remote-head CI, merge or readiness claim for unpublished work.
