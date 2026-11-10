# Supply Vanguard shared task board

Revision 287. Live state is on the task-board branch. Use npm run board -- claim; do not edit this table manually.

| Task | Status | Owner / agent | Lease expiry (UTC) | Dependencies | Work |
|---|---|---|---|---|---|
| SV-000 Bootstrap repository and shared claiming board | done | — | — | — | apps/web, packages/scene, tools/board.mjs |
| SV-001 Define equipment and event contracts | done | — | — | — | [PR](https://github.com/wiltobuild/supply-vanguard/pull/2) |
| SV-002 Extract configurable ward and model mapping | done | — | — | — | [PR](https://github.com/wiltobuild/supply-vanguard/pull/3) |
| SV-003 Accessible equipment workflows and fallback | done | — | — | — | [PR](https://github.com/wiltobuild/supply-vanguard/pull/5) |
| SV-004 Database foundation and migrations | done | — | — | — | [PR](https://github.com/wiltobuild/supply-vanguard/pull/4) |
| SV-005 Authentication and role authorization | done | — | — | SV-004 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/7) |
| SV-006 Equipment API and immutable audit transactions | done | — | — | SV-001, SV-004, SV-005 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/8) |
| SV-007 Connect web client to shared equipment API | done | — | — | SV-003, SV-006 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/13) |
| SV-008 Barcode and QR manual check-in | claimed | wil / wil-sol-sv008-20261105-f28c | 2026-11-10T03:15:49.197Z | SV-001, SV-006 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/14) |
| SV-009 Supply ledger and bin inventory | done | — | — | SV-004, SV-005 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/9) |
| SV-010 Replenishment queue and low-stock alerts | blocked | — | — | SV-007, SV-009 | apps/web/supplies, services/api/replenishment |
| SV-011 Equipment cleaning and maintenance workflows | review | — | — | SV-006, SV-007 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/22) |
| SV-012 Audit search and permission-scoped export | done | — | — | SV-006, SV-009 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/19) |
| SV-013 Provider-neutral observation ingestion simulator | done | — | — | SV-001, SV-004, SV-005 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/10) |
| SV-014 Location confidence and RTLS adapter boundary | done | — | — | SV-006, SV-013 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/18) |
| SV-015 Validate ward reference geometry | blocked | — | — | SV-002 | packages/scene/references |
| SV-016 End-to-end and performance verification | ready | — | — | SV-007, SV-008, SV-010, SV-011, SV-012, SV-014 | tests/e2e, tools/benchmarks |
| SV-017 Deployment and operational readiness | ready | — | — | SV-006, SV-013 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/17) |
| SV-018 Ward pilot and release sign-off | ready | — | — | SV-015, SV-016, SV-017 | planning/pilot |
| SV-019 Repair auth bootstrap and clean test setup | claimed | wil / wil-vale-sv019-20261105-authfix | 2026-11-05T21:02:50.626Z | SV-005 | services/api/db bootstrap/seed, task-specific auth tests/dependency wiring, root package/test-loader and CI changes required for the two regressions only |
| SV-020 Requests and atomic item assignments | done | — | — | SV-006 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/11) |
| SV-021 Independent stacked equipment holds | done | — | — | SV-006, SV-020 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/23) |
| SV-022 Partial fulfillment and safe returns | blocked | — | — | SV-020, SV-021 | Task-local request fulfillment lifecycle, Task-local return lifecycle integration |
| SV-023 Repair equipment replay and concurrency | done | — | — | SV-006 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/12) |
| SV-024 Add fifteen illustrative NICU equipment assets | done | — | — | SV-002 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/16) |
| SV-025 Build illustrative pediatric intensive care ward (PICU) | done | — | — | SV-002 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/20) |
| SV-026 Build illustrative pediatric cardiac step-down ward (PCU) | done | — | — | SV-002 | [PR](https://github.com/wiltobuild/supply-vanguard/pull/21) |
| SV-027 Build task-local request, holds and returns UI | blocked | — | — | SV-007, SV-020, SV-021 | apps/web/requests, apps/web/tests/request-lifecycle.test.mjs |
