# SV-024 verification evidence

Verified on 2026-11-05 against baseline main commit `75f2cf60a645aa9a40363b9836b3830047d77ca5`, in an isolated branch. All twelve original GLBs match their baseline SHA-256 hashes, recorded in `tests/fixtures/original-glbs.sha256.json`.

## Checks

| Check | Result |
| --- | --- |
| `npm test` | 55 tests: 49 passed, 0 failed, 6 skipped |
| `npm run check` | JavaScript syntax, 27 GLB containers and 19 seed task definitions validated |
| Fifteen deterministic source/export comparisons | Passed |
| Khronos glTF Validator | All 15 additions: zero errors, zero warnings |
| Three.js GLTFLoader round-trip | All 15 load with finite bounds matching manifest dimensions |
| Original assets | All 12 GLBs unchanged byte for byte |
| Placement | No intersections with original obstacle footprints, other additions or initial tracked equipment |
| Navigation | Exact approaches for all 10 rooms and 9 supply locations are walkable and reachable; central corridor and charging-bay approach remain clear |
| Browser catalog | 25 rows; all 15 additions inspected and downloaded without page/HTTP errors |
| Browser walking | Completed equipment-store route to EQ-A; arrival event, camera X/Z `[-9.6, 4.6]`, zero remaining route points |
| WebGL-disabled gallery | Descriptions and all 15 download links remain available |

Six existing native PostgreSQL tests are skipped because native PostgreSQL is unavailable in this environment. Existing auth and equipment tests ran successfully with the locked PGlite dependencies installed; no dependency manifests changed. The shared-board race test ran outside the restricted temp-directory sandbox and passed.

Machine-readable evidence: [GLB validation](glb-validation.json), [browser validation](browser-validation.json) and [final gallery layout/fallback validation](gallery-validation.json). The final gallery renders 15 static image previews with no retained visible canvases, fits a 390 px viewport without horizontal overflow, and provides 44 px link targets. Optional repeatable QA tools are documented in [ADDITIONAL_ASSETS.md](../../ADDITIONAL_ASSETS.md).

## Screenshots

- [All fifteen models](asset-gallery.png): original procedural collection; the final gallery also includes 44 px download targets and visible keyboard focus.
- [Preserved ward with additions](ward-overview.png).
- [Ventilator in the interactive library](ventilator-inspector.png).
- [Equipment-store overview](equipment-store.png).
- [Completed equipment-store walk](equipment-store-walk.png).

The gallery, overview and inspector were captured at 1536 × 1000. Final navigation ran in Chromium 141 using SwiftShader at a 1200 × 800 viewport and 0.4 device scale, with a CSS-size screenshot. Software rendering was slow: the initial far-room browser route timed out after 45 seconds, and a progress-logged retry continued normally down the corridor but did not finish within its 120-second cap. The nearby equipment-store route completed at reduced resolution. These checks establish functional rendering/navigation, not workstation performance or frame-rate targets. Browsers were closed after verification.

The original ward GLBs and accompanying saved navigation JSON remain baseline snapshots. The live procedural ward is the integration source for the fifteen additions. Room assignments, model sizes and clean/soiled staging are illustrative; no architectural, clinical or manufacturer validation is claimed. Arbitrary later inventory moves remain subject to the pre-existing slot planner and may overlap static decoration.
