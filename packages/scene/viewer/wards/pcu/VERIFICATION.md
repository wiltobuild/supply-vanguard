# SV-026 verification — 5 November 2026

Story: open the standalone PCU preview, inspect the illustrative section, find a synthetic equipment model, enter its room, and return to the existing NICU/equipment workspace. The scene reads static local configuration and the existing model library; there is no API or operational inventory boundary in this preview.

## Automated results

| Check | Observed result |
| --- | --- |
| Ward suite: `node --import ./packages/scene/viewer/wards/pcu/tests/register.mjs --test packages/scene/viewer/wards/pcu/tests/pcu.test.mjs` | 6 passed, 0 failed. Unique PCU identities, existing model reuse/finite bounds, every room/support entry point connected to the corridor, wall/boundary collision and anti-tunneling, search semantics, standalone return/fallback routes |
| `npm test` | 45 passed, 0 failed, 6 skipped. Native PostgreSQL is unavailable; its six existing database checks did not run |
| `npm run check` | JavaScript syntax, all 12 original GLB containers and 19 seed task definitions validated. The live board is separate from the seed |
| Scope preservation | New files only under `packages/scene/viewer/wards/pcu/`; original NICU, model sources, shared entry/app/navigation/registry/manifests, dependencies, APIs and plan unchanged |

The clean clone initially needed the repository's locked PGlite test dependency: `npm ci --prefix services/api/auth --ignore-scripts`. The Windows sandbox blocked Git subprocesses in the existing board-race test; running tests with normal host access and TEMP/TMP at the normal user temporary directory passed. No production service or test-loader change was made.

Accurate asset bounds exposed a workstation chair blocking the supply-room entry. The workstation was moved deeper into its illustrative store; all entry-clearance tests then passed. Browser testing also corrected the return URL from the workspace's fallback hash to its actual `/#/equipment` route, and fitted the overview camera to narrow screens.

## Browser observations

Preview verified with the in-app browser at `http://127.0.0.1:4197/ward/wards/pcu/index.html` (local task preview only). Source also runs with the repository's normal port. A sandbox-started server on 4196 was inaccessible and stopped; the loopback host preview on 4197 returned HTTP 200 and rendered successfully. No networking settings were changed.

- Overview and interior render with the original procedural equipment. No browser warnings/errors were reported by the page log check.
- Searching `IV pump` gives 9 of 26 synthetic examples and blue rings. Searching `bay A1` gives three. Selecting A1's pump exposes its stable ID, room and synthetic provenance; entering that room shows its bed, pump, monitor and family seating. Keyboard walk input and return-to-overview controls were exercised.
- `?view=list` creates **zero canvases**. Filtering to IV pumps still gives nine examples and selecting `pcu-store-iv` exposes its ID and illustrative store. There is no misleading live stock status. This explicitly exercises graphics-free mode; a real hardware WebGL failure/context loss was not induced.
- At a 390 × 844 viewport, document width was 375 CSS pixels (within the 390-pixel viewport), with stacked layout and a fitted overview. The temporary viewport override was reset. Full-page capture failed at this narrow size; the saved mobile evidence is the bounded viewport capture.
- NICU link opens the unchanged original ward; Equipment workspace opens the existing equipment register with eight original sample assets. Shared PICU/PCU selector integration remains with SV-025 and was not imported from an unmerged branch.
- Sources dialog presents the evidence limits and public links; Escape dismisses it. Keyboard-focused inputs, semantic buttons, explicit labels and list selection work. A formal screen-reader/device-matrix audit and clinical-workstation performance benchmark were not run.
- Save view exports the current rendered camera with an inseparable illustrative-model caption. Overview and interior JPGs were downloaded and visually inspected.

## Evidence

All pictures show the authored concept, not an authenticated hospital floor plan. No public photograph is copied into these artifacts.

- [Overview with app context](evidence/overview-ui.jpg)
- [Interior with app context](evidence/interior-ui.jpg)
- [IV pump search/highlight](evidence/iv-pump-search.jpg)
- [List-only fallback](evidence/list-fallback.jpg)
- [Narrow layout](evidence/mobile.jpg)
- [Sources and limits](evidence/sources.jpg)
- [Captioned overview render](evidence/overview.jpg)
- [Captioned interior render](evidence/interior.jpg)

The final overview export and app-context overview include the supply-workstation clearance correction. The interior rendering shows the final bay geometry.

## Coordination and limits

Base: main `5e1100ca`. Normal SV-026 claim confirmed at live board revision 94, owner `wil`, agent `wil-astra-ward-two-20261105`; retained claim renewed at revisions 114 and 123 before finalization. Work branch: `task/sv-026-wil-astra-ward-two-20261105`. Draft PR only; no merge or deployment is part of this task.

Approved measured geometry, current ward-specific imagery, verified room mappings, real equipment inventory and authorized facilities/staff review remain unavailable. Those gaps are documented in [REFERENCE.md](REFERENCE.md) and block any claim of exact physical fidelity. Broader timeline, cross-ward inventory and borrowing workflows remain plan work, not capabilities of this static section.
