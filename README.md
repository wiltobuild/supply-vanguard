# Supply Vanguard shared task board

Revision 70. Live state is on the task-board branch. Use npm run board -- claim; do not edit this table manually.

| Task | Status | Owner / agent | Lease expiry (UTC) | Dependencies | Work |
|---|---|---|---|---|---|
| SV-000 Bootstrap repository and shared claiming board | done | — | — | — | apps/web, packages/scene, tools/board.mjs |
| SV-001 Define equipment and event contracts | done | — | — | — | [PR](https://github.com/wiltobuild/supply-vanguard/pull/2) |
| SV-002 Extract configurable ward and model mapping | done | — | — | — | [PR](https://github.com/wiltobuild/supply-vanguard/pull/3) |
| SV-003 Accessible equipment workflows and fallback | done | — | — | — | [PR](https://github.com/wiltobuild/supply-vanguard/pull/5) |
| SV-004 Database foundation and migrations | done | — | — | — | [PR](https://github.com/wiltobuild/supply-vanguard/pull/4) |
| SV-005 Authentication and role authorization | done | — | — | SV-004 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/7) |
| SV-006 Equipment API and immutable audit transactions | done | — | — | SV-001, SV-004, SV-005 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/8) |
| SV-007 Connect web client to shared equipment API | claimed | wil / wil-sol-sv007-20261105-9f2a | 2026-11-05T19:11:51.877Z | SV-003, SV-006 | apps/web |
| SV-008 Barcode and QR manual check-in | ready | — | — | SV-001, SV-006 | apps/web/check-in, services/api/check-in |
| SV-009 Supply ledger and bin inventory | review | — | — | SV-004, SV-005 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/9) |
| SV-010 Replenishment queue and low-stock alerts | ready | — | — | SV-007, SV-009 | apps/web/supplies, services/api/replenishment |
| SV-011 Equipment cleaning and maintenance workflows | ready | — | — | SV-006, SV-007 | apps/web/maintenance, services/api/maintenance |
| SV-012 Audit search and permission-scoped export | ready | — | — | SV-006, SV-009 | apps/web/audit, services/api/audit |
| SV-013 Provider-neutral observation ingestion simulator | review | — | — | SV-001, SV-004, SV-005 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/10) |
| SV-014 Location confidence and RTLS adapter boundary | ready | — | — | SV-006, SV-013 | services/ingestion/resolution, packages/domain/location |
| SV-015 Validate ward reference geometry | blocked | — | — | SV-002 | packages/scene/references |
| SV-016 End-to-end and performance verification | ready | — | — | SV-007, SV-008, SV-010, SV-011, SV-012, SV-014 | tests/e2e, tools/benchmarks |
| SV-017 Deployment and operational readiness | ready | — | — | SV-006, SV-013 | ops, .github/workflows |
| SV-018 Ward pilot and release sign-off | ready | — | — | SV-015, SV-016, SV-017 | planning/pilot |
| SV-019 Repair auth bootstrap and clean test setup | claimed | wil / wil-vale-sv019-20261105-authfix | 2026-11-05T19:07:59.436Z | SV-005 | services/api/db bootstrap/seed, task-specific auth tests/dependency wiring, root package/test-loader and CI changes required for the two regressions only |
| SV-020 Requests and atomic item assignments | review | — | — | SV-006 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/11) |
| SV-021 Independent stacked equipment holds | ready | — | — | SV-006, SV-020 | packages/domain/holds, services/api/holds, Task-local assignment-eligibility integration |
| SV-022 Partial fulfillment and safe returns | ready | — | — | SV-020, SV-021 | Task-local request fulfillment lifecycle, Task-local return lifecycle integration |
| SV-023 Repair equipment replay and concurrency | claimed | wil / wil-vale-sv023-20261105-receipts-a81f | 2026-11-05T19:19:09.473Z | SV-006 | services/api/equipment, services/api/equipment task-local migrations, tests and documentation only |
