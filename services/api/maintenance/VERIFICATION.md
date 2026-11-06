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
