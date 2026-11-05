# SV-014 verification — 2026-11-05

Owner `wil`; agent `wil-sol-sv014-20261105-resolve`. Normal live claim confirmed with exit 0
at board revision **97**, 19:02:23 UTC. Same checkout retains ignored `.claims/SV-014.json`.
Latest pre-commit heartbeat confirmed revision **117**, expiry 21:22:55 UTC.

Branch: `task/sv-014-wil-sol-sv014-20261105-resolve`.
Tested base: `5e1100cae690f001fa4964bb73f52479598f6e75` (current main when cloned).
During work, remote main advanced to `6eebdad5d94e1ecf28b9137885fc996836647ff7` through
PRs #12, #9 and #11. No rebase/merge was performed. Those changes do not modify the domain
observation contract, core observation schema, auth or ingestion interfaces consumed here.
Integration/merge sequencing remains with the designated PR manager.

Environment: authorized Windows desktop, Node **24.18.0**, pinned native PostgreSQL **18.6**
from the existing ingestion test package. No new dependency declarations or lockfile edits.
Linux/Node 22 and repository CI are separate execution stages, not implied by these local runs.

| Command | Actual result |
| --- | --- |
| `node --test tests/location.test.mjs` | **8 passed, 0 failed, 0 skipped** |
| `node --test services/ingestion/resolution/tests/resolution.test.mjs` | Final run: **9 passed, 0 failed, 0 skipped**, 179.8 s |
| `npm test --prefix services/ingestion` | **19 passed, 0 failed, 0 skipped**, 212.2 s |
| `npm test` | **31 passed, 2 failed, 16 skipped**, 49 total, exit 1 |
| `npm run check` | **Passed**: JS syntax, all 12 existing GLB containers and 19 seed task definitions |
| `git diff --cached --check` | Passed for the staged implementation |

The required root failures were:

- Auth test loader: `ERR_MODULE_NOT_FOUND` for `@electric-sql/pglite` in the clean checkout.
  No auth/dependency/loader repair or reserved SV-019 patch reconstruction was attempted.
- Board race: temporary `remote.git/config` creation returned Windows sandbox `Permission denied`.
  The denied temporary Git operation was not retried under another identity or path.

The 16 root skips were six core database tests (root PostgreSQL discovery reported unavailable)
and ten equipment PGlite tests (dependency not installed). These skips do not count as native
resolver coverage. The separate task/native and unchanged ingestion suites above did execute
real PostgreSQL tests outside the restricted sandbox in the authorized desktop environment.

The final resolver native run included real foreign-tenant equipment/location fixtures; denied
viewer/operator overrides; unchanged operator general-audit denial; source-authenticated intake;
late/replayed/conflicting input; status-edit independence; stale/unknown states; audited, bounded
overrides; expiry without older-location resurrection; original-snapshot retries after expiry;
actor-bound key collision; audit failure rollback; deferred-FK rejection of unaudited facts;
append-only evidence; capped evidence fail-closed behavior; and migration down/up isolation.

Concurrency evidence is native, not serialized fixtures: the identical-key test held an actual
advisory transaction lock, observed at least two separate backend sessions waiting concurrently,
then released it and asserted one new override/audit plus one original-snapshot replay.
Different-key attempts for one equipment item produced exactly one successful override.

The root CI workflow does not run the new native resolver or existing ingestion suite. Their
coverage is the local evidence above. Exact-head CI/publication evidence is recorded in the PR
after push. No hardware, browser/scene integration, production deployment, measured clinical
threshold, patient identifiers, feature merge or board completion is claimed.
