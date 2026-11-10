# SV-010 verification evidence

## Local access-response repair (unpublished)

The retained public `cf43d810` client parsed JSON before interpreting HTTP rejection. HTML, empty or broken JSON on 401/403 therefore lost the status; rejected writes were marked uncertain and the UI could retain unauthorized cached records, drafts and pending commands. The local repair retains authoritative HTTP status even when rejection bodies cannot be decoded. It preserves valid JSON error codes and keeps true transport/5xx-write and successful-write unreadable-response uncertainty.

Focused command: `node --test services/api/replenishment/tests/access-response.test.mjs`.

- Before repair: **1 passed, 11 failed**; the network/5xx/successful-write uncertainty control passed.
- After repair: **12 passed, 0 failed, 0 skipped**. Client tests cover read/write 401/403 with HTML, empty and broken JSON, valid error codes, invalid JSON shapes, transport failure, 5xx and malformed 201. Controlled DOM tests cover read/write/pending-retry denials, clearing cached records/pending requests/drafts, and fresh keys/blank drafts after access returns.
- This file imports no SQL fixture, starts no listener, and performs no real network, browser or provisioning operation. The full database/DOM fixture suite and root tests were not rerun; historical evidence below remains separate.
- `npm run check` passed after the local repair. The published commit is unchanged; repair publication and GitHub PR creation remain separate handoff gates.

Base inspected: main `94d2f97` (merged web/API PR #13). Claim confirmed **exit 0**, live board revision **172**, owner `wil`, agent `wil-sol-sv010-20261106-replenishment`, at `2026-11-06T01:16:45.675Z`. Dependencies SV-007 and SV-009 were done. Scope is exactly `apps/web/supplies` and `services/api/replenishment`.

## Passed

- `npm test --prefix services/api/replenishment --workspaces=false`: **19 passed, 0 failed, 0 skipped**, local Node v24.18.0. Thirteen API/SQL tests plus six client/DOM tests. PGlite 0.5.15, JSDOM 26.1.0, axe-core 4.10.3. Tests create only in-memory synthetic records/roles, with non-owner/NOSUPERUSER/NOBYPASSRLS runtime and a non-superuser supply/replenishment schema owner.
- API acceptance: unconfigured/equal/strictly-below-par boundaries, explicit exact fractional units, repeated detection and immutable original replay, versioned configuration, assignment ownership, completion/closure, count correction including no-op audit, ledger immutability, membership revocation, actor/key binding, cross-tenant IDs/RLS, invalid input/page/body limits, safe HTTP errors, rollback after ledger/task/event/receipt writes, task-local migration down/up preserving shared ledger/auth.
- Concurrent JS calls are **serialized by the single-connection PGlite fixture**. They check replay/one-winner behavior without claiming native locking proof.
- DOM → client → in-process Node HTTP handler → existing auth → SQL → refetch acceptance covers configure/detect/assign/complete/correct/history and focus restoration. No socket listener, fake production identity, or operational connection is used. A lost response after a real SQL commit retries the exact original command/key, including after queue refetch hides the completed task. Conflict drafts, stale-save truthfulness, empty/read-only/offline/revoked states pass.
- Axe DOM scan: **zero violations**, with `color-contrast` explicitly disabled because JSDOM cannot render layout.
- `npm run check`: **passed**; JavaScript syntax, all **27 GLB containers**, and 19 seed task definitions validated. Existing root shared-token WCAG AA contrast and accessibility-shell checks also passed.
- Task-local dependency install audit: **0 vulnerabilities**.

## Root suite failure and skips

Executed `npm test -- --test-skip-pattern='two independent agent checkouts cannot both claim the same remote task'`. Npm appended the flag after the file glob and Node did not apply the attempted exclusion. Result: **84 tests, 46 passed, 2 failed, 36 skipped** (exit 1).

Failures:

1. `tests/auth.test.mjs`: `ERR_MODULE_NOT_FOUND` for `@electric-sql/pglite` under `services/api/auth`. Task-local dependencies do not repair the auth/root loader setup, which remains SV-019 scope. No auth/bootstrap/dependency/loader/CI file was edited.
2. `tests/board-race.test.mjs`: Git fixture failed at `git init --bare` writing `C:/Users/Wil/AppData/Local/Packages/sandbox.{ba290051-ecec-4680-b555-d03d24765d7d}/AC/Temp/vanguard-race-OxdFLY/remote.git/config`: **Permission denied**, exit 128. No test remote/claim was initialized. Operation stopped, no retry, directory/identity/worker workaround or board-test repair attempted.

Skips: 8 audit SQL, 10 equipment SQL, 9 requests SQL because auth's PGlite dependency was unavailable; 6 native core DB and 3 native request-race tests because PostgreSQL was not found. These are skipped, not passed.

## Browser denial and unrun checks

Attempt: CUA `createBrowserTab('chrome', 'file:///C:/Users/Wil/Documents/Codex/2026-11-05/task-19/supply-vanguard/services/api/replenishment/tests/synthetic-preview.html')`.

Result: **denied before opening**. Exact reason: “The browser URL policy blocks this action… The requested URL protocol is not allowed. Allowed protocols: http:, https:.” Policy explicitly forbade indirect/alternate-surface workarounds. The action did not execute; no browser screenshot exists. User-message history contained no new relevant authorization to change that outcome. No browser retry or alternate preview-serving route was attempted.

Unrun: real browser desktop/narrow layout, keyboard/contrast/reduced-motion rendering; native multi-session same-key and competing completion/external-ledger races; real host/API/DB mounting and authenticated runtime flow. The inherited native PostgreSQL/loopback restrictions were not retried. No native cluster or loopback HTTP listener was started by this task's fixtures.

## Integration and review limits

The mountable modules are not reachable in the actual shared app; see the exact host/static route/auth lifecycle requirements in `apps/web/supplies/README.md`. Current CI does not discover this task-local suite; reviewers must explicitly run it. Synthetic preview values are test-only, not defaults. No operational quantities, role grants, notification providers, production services, credentials, patient data, merge or deployment were introduced. Draft PR and normal board submit receipts are reported with the delivery; only the existing independent PR manager may review/merge and mark complete.

## Lifecycle repair: deferred old-session work after destroy() or replacement (SV-010 review follow-up)

Review of the frozen head (`bcfd05ce`, rebuilt here as `cf43d81` plus the approved access-response patch; all 21 authored files matched the manifest) traced reads and writes through `destroy()` and replacement mounting on the same root. Two defects were reproduced and are now fixed in `apps/web/supplies/view.mjs`, each with a regression that **failed on the unrepaired source** and passes now:

1. **Focus taken by an old session.** A save (or a retried save) succeeded, its refresh was still in flight, the session was destroyed or replaced, and when the refresh finished the old handler continued and focused `doc.getElementById('supply-<binId>')`, which matched the **new** session's heading. Fixed two ways that overlap on purpose: the handler returns if the session was disposed, and the focus lookup is scoped to the instance's own bins area instead of the whole document (so a session that was replaced without `destroy()` cannot find another mount's heading either).
2. **Destroying an old session erased a newer one.** `destroy()` ran `root.replaceChildren()`, so destroying the old session after the new one mounted wiped the new UI. Now it removes only the nodes this instance put in the root, drops the `supplies` class only if nothing else remains, and a second `destroy()` is harmless.

Not a defect (kept as a guard): an old session's draft, pending request or idempotency key, and its late 403, never reach a new session; all per-mount state lives in that mount's closure.

Commands: `node --test services/api/replenishment/tests/lifecycle.test.mjs` (6 tests, controlled synthetic collaborators only: a real client over a fake fetch and jsdom; no SQL fixture, server, network or provisioning). `node services/api/replenishment/tests/lifecycle-mutations.mjs` is a by-hand inventory (not a test) that breaks `view.mjs` nine ways and checks the tests notice: every mutation that should be caught is; the two that remove only the disposed check survive by design because the scoped lookup covers the same hole, and the combined mutations are caught.

Still unrun and outside this repair: live runtime, integration with the shared host (SV-008) and lifecycle owners, native database, browser keyboard checks.
