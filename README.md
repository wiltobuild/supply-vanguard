# Supply Vanguard shared task board

Revision 23. Live state is on the task-board branch. Use npm run board -- claim; do not edit this table manually.

| Task | Status | Owner / agent | Lease expiry (UTC) | Dependencies | Work |
|---|---|---|---|---|---|
| SV-000 Bootstrap repository and shared claiming board | done | — | — | — | apps/web, packages/scene, tools/board.mjs |
| SV-001 Define equipment and event contracts | review | — | — | — | [PR](https://github.com/wiltobuild/supply-vanguard/pull/2) |
| SV-002 Extract configurable ward and model mapping | review | — | — | — | [PR](https://github.com/wiltobuild/supply-vanguard/pull/3) |
| SV-003 Accessible equipment workflows and fallback | review | — | — | — | [PR](https://github.com/wiltobuild/supply-vanguard/pull/5) |
| SV-004 Database foundation and migrations | review | — | — | — | [PR](https://github.com/wiltobuild/supply-vanguard/pull/4) |
| SV-005 Authentication and role authorization | ready | — | — | SV-004 | services/api/auth |
| SV-006 Equipment API and immutable audit transactions | ready | — | — | SV-001, SV-004, SV-005 | services/api/equipment |
| SV-007 Connect web client to shared equipment API | ready | — | — | SV-003, SV-006 | apps/web |
| SV-008 Barcode and QR manual check-in | ready | — | — | SV-001, SV-006 | apps/web/check-in, services/api/check-in |
| SV-009 Supply ledger and bin inventory | ready | — | — | SV-004, SV-005 | services/api/supplies, packages/domain/supplies |
| SV-010 Replenishment queue and low-stock alerts | ready | — | — | SV-007, SV-009 | apps/web/supplies, services/api/replenishment |
| SV-011 Equipment cleaning and maintenance workflows | ready | — | — | SV-006, SV-007 | apps/web/maintenance, services/api/maintenance |
| SV-012 Audit search and permission-scoped export | ready | — | — | SV-006, SV-009 | apps/web/audit, services/api/audit |
| SV-013 Provider-neutral observation ingestion simulator | ready | — | — | SV-001, SV-004, SV-005 | services/ingestion |
| SV-014 Location confidence and RTLS adapter boundary | ready | — | — | SV-006, SV-013 | services/ingestion/resolution, packages/domain/location |
| SV-015 Validate ward reference geometry | ready | — | — | SV-002 | packages/scene/references |
| SV-016 End-to-end and performance verification | ready | — | — | SV-007, SV-008, SV-010, SV-011, SV-012, SV-014 | tests/e2e, tools/benchmarks |
| SV-017 Deployment and operational readiness | ready | — | — | SV-006, SV-013 | ops, .github/workflows |
| SV-018 Ward pilot and release sign-off | ready | — | — | SV-015, SV-016, SV-017 | planning/pilot |
