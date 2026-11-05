# SV-026 verification — 5 November 2026

Story: open the standalone PCU preview, inspect the illustrative section, find a synthetic equipment model, enter its room, and return to the existing NICU/equipment workspace. The scene reads static local configuration and the existing model library; there is no API or operational inventory boundary in this preview.

## Automated results

| Check | Observed result |
| --- | --- |
| Ward suite: `node --import ./packages/scene/viewer/wards/pcu/tests/register.mjs --test packages/scene/viewer/wards/pcu/tests/*.test.mjs` | 7 passed, 0 failed. Unique PCU identities, existing model reuse/finite bounds, every room/support entry point connected to the corridor, wall/boundary collision and anti-tunneling, search semantics, standalone return/fallback routes, selection focus/context regression |
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

### PR #21 keyboard rework

Normal reclaim of SV-026 confirmed at board revision 131 on the same branch and agent. Reproduced the reviewer's defect on the original head: filter `bay A1`, Tab from the search through equipment type to the pump, then Enter. Selection appeared but focus fell to BODY because the result list was rebuilt.

Selection now updates the existing rows' pressed state in place. Asynchronous 3D initialization also retains the rows and restores any selection made while the viewer loaded. Filtering continues to rebuild results when the user changes the search/type.

The new `keyboard-regression.test.mjs` executes the actual list-only app in a minimal DOM fixture with focus-on-removal behavior. It failed before the fix and passes afterward, checking focused-node identity, result identity, scroll/query preservation, repeated selection, next-row selection, pressed states and graphics-free mode. It is not a substitute for native keyboard testing.

Native IAB testing on the repaired code confirmed in both 3D and `?view=list`: Enter selects A1's IV pump with `document.activeElement` still that BUTTON; repeated Enter and Space retain focus; Tab reaches the A1 monitor and Space selects it, clearing the pump's pressed state. The query remains `bay A1`, the selected detail matches the monitor, and exactly one row is pressed. The 3D view had one canvas and `data-scene-ready=pcu-bloomberg-9n`; list mode had zero canvases. [3D keyboard evidence](evidence/keyboard-3d.jpg) and [graphics-free keyboard evidence](evidence/keyboard-list.jpg) show the resulting focused selection. A browser-tool timeout interrupted the first fallback batch; inspecting the existing page confirmed pump selection before the remaining checks continued.

After the repair: all seven ward tests passed; `npm test` again passed 45 with the six existing native PostgreSQL skips; `npm run check` passed. PCU route and `body[data-ward="pcu"]` remain compatible with SV-025's availability probe. Shared selector ownership remains with SV-025; combined navigation requires that integration review and is not claimed here.

### PR #21 Back/forward rework

Reclaimed normally at board revision 139 after independent review of `47ee00f`. Reproduced Back restoring the IV-pump type while 26 rows remained. Initial rendering ran before browser form restoration; viewer readiness only refreshed the count/highlights.

Each history entry now retains both filter controls in namespaced history state. A deferred `pageshow` reconciliation reads that state after native form restoration (or uses the native values for older entries). List rows, count and 3D highlights use the same matches, including when the viewer becomes ready. Rows are rebuilt only when their result IDs change, retaining focus and scroll for unchanged results and page-cache restores. No extra history entries, persistent storage or shared navigation files were added.

The app regression now covers native values restored after `pageshow` without input/change, cached-page events, nine pumps, one monitor, zero matches, preservation of unrelated history state, and both controls restored from saved state even when native restoration clears them. Existing focus/node/scroll/selection assertions still pass. The fixture simulates lifecycle events; actual Back and Forward were separately exercised in IAB.

Final browser verification used different filters on adjacent 3D/list history entries:

| Traversal | Restored controls and exact rows | Graphics |
| --- | --- | --- |
| Back to list | Empty query + IV pumps; nine `*-iv` rows, count 9 | Zero canvases |
| Forward to 3D | `A1` + Patient monitors; only `pcu-bay-a1-monitor`, count 1 | One canvas, matching 3D highlight |
| Back to 3D | `A1` + Patient monitors; only `pcu-bay-a1-monitor`, count 1 | One canvas, matching 3D highlight |
| Forward to list | `store` + IV pumps; only `pcu-store-iv`, count 1 | Zero canvases |

Enter selected the restored 3D monitor and list-mode pump without moving focus from their buttons. Evidence: [Back to list](evidence/history-back-list.jpg), [Forward to 3D](evidence/history-forward-3d.jpg), [Back to 3D](evidence/history-back-3d.jpg), [Forward to list](evidence/history-forward-list.jpg). Seven ward tests and the required repository checks were rerun. Browser page-cache use itself was not forced; cached-event behavior is covered by the fixture.

Base: main `5e1100ca`. Normal SV-026 claim confirmed at live board revision 94, owner `wil`, agent `wil-astra-ward-two-20261105`; retained claim renewed at revisions 114 and 123 before finalization. Work branch: `task/sv-026-wil-astra-ward-two-20261105`. Draft PR only; no merge or deployment is part of this task.

Approved measured geometry, current ward-specific imagery, verified room mappings, real equipment inventory and authorized facilities/staff review remain unavailable. Those gaps are documented in [REFERENCE.md](REFERENCE.md) and block any claim of exact physical fidelity. Broader timeline, cross-ward inventory and borrowing workflows remain plan work, not capabilities of this static section.
