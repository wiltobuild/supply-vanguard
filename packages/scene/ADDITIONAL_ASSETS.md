# Fifteen illustrative NICU additions — SV-024

These original procedural models extend the existing kit with the same rounded forms, muted teal/ivory/steel materials, transparent housings and geometry-based details. All dimensions are estimates in meters, Y up, +Z front. They are representative forms, not manufacturer replicas, measured Hopkins equipment or clinical-use specifications.

The live ward places one of each addition as **static decoration, not tracked inventory**. No inventory records, room IDs, location IDs or tracked-model registry entries were added. User-facing catalog rows and the ward footer state that distinction. Names such as resuscitation, charging and soiled describe modeled forms, not operational readiness, verified storage procedures or validated infection-control zoning.

| Model / GLB filename | Illustrative placement | Distinguishing geometry |
| --- | --- | --- |
| `neonatal-ventilator.glb` | Room 101 side space | Console, humidifier, twin circuit and support arm |
| `cpap-stand.glb` | Room 102 side space | Flow controls, chamber and breathing loop |
| `phototherapy-light.glb` | Room 104 side space | Adjustable mast and blue LED head |
| `ultrasound-cart.glb` | Room 105 side space | Scan display, console keys and cabled probes |
| `portable-xray.glb` | Room 103 left side | Generator, jointed arm, tube head and detector storage |
| `transport-incubator.glb` | Room 106 left side | Hood, mattress, stretcher frame and gas cylinders |
| `infant-scale.glb` | Room 102 left side | Raised weighing tray and mobile storage base |
| `feeding-pump-stand.glb` | Room 103 side space | Purple enteral pump, feed bag and tubing, distinct from the original infusion stand |
| `portable-suction.glb` | Room 106 side space | Dial gauge, pump, twin jars and suction hose |
| `resuscitation-cart.glb` | Room 104 left side | Coral drawer bank, kit tray and cylinder |
| `milk-refrigerator.glb` | Staff workroom rear perimeter | Hollow cabinet, glazed door and visible bottle shelves |
| `milk-preparation-counter.glb` | Staff workroom side perimeter | Worktop, bottle rack and closed storage |
| `equipment-charging-station.glb` | Equipment-store front wall | Nine representative docked units and managed cables |
| `soiled-equipment-rack.glb` | Equipment-store east perimeter | Separate trays, coral designation and covered bin |
| `wall-ppe-dispenser.glb` | Room 101 side wall | Glove boxes, mask pocket and gown compartment |

The equipment store has no dedicated soiled room in the original layout. The soiled rack is an illustrative staging prop along its east perimeter, separated from the front-wall charging station; this is not a validated clean/dirty workflow. Room assignments were chosen for visible space and navigability, not as a claim about real clinical placement. Milk storage/preparation is similarly a concept placement in the existing staff room, not a new authorized milk room.

## Reuse and regeneration

`viewer/additional-models.js` contains the fifteen builders; they receive the original kit's geometry helpers and material palette from `viewer/models.js`. Existing builders and all twelve pre-existing GLBs remain unchanged. `viewer/additional-assets.js` contains catalog descriptions, provenance and placements. `createAsset(kind)` exposes all 25 equipment types and shares immutable geometry/materials between clones.

All models have a floor-reference pivot. The wall PPE case occupies Y 1.05–1.78 m above that reference; its origin is intentionally below the visible case, allowing direct ward placement and consistent meters/Y-up integration.

Run from the repository root with Node 22+:

```sh
node tools/export-additional-assets.mjs
node --test tests/additional-assets.test.mjs
npm test
npm run check
```

The exporter uses the repository's vendored Three.js and a deterministic, texture-free GLB writer; no application dependencies were added. It regenerates only the fifteen additions and their manifest records. The original full/cutaway ward GLBs are preserved baseline snapshots; the live procedural ward includes the additions. The download button is labeled **Original ward GLB** to make that distinction visible.

For independent Khronos validation and GLTFLoader round-trip checks, install optional QA tools in a directory outside the repository:

```sh
npm install --prefix ../asset-tools --ignore-scripts three@0.180.0 gltf-validator@2.0.0-dev.3.10
node tools/verify-additional-glbs.mjs ../asset-tools
```

Optional browser smoke check against a running `npm run dev` server (requires a Playwright Chromium installation):

```sh
npm install --prefix ../asset-tools --ignore-scripts playwright@1.56.1
node tools/verify-additional-browser.mjs ../asset-tools http://127.0.0.1:4180
```

See [verification evidence](verification/SV-024/README.md), including the fifteen-model contact sheet and ward screenshots. The gallery uses one offscreen renderer to generate static image previews, disposes it afterward, and preserves descriptions/downloads when WebGL is unavailable. Interactive inspection remains in the ward's asset library.

## Navigation and limits

Placement uses transformed model bounds for collision obstacles. The saved `navigation.json` accompanies the preserved baseline ward exports; live collision bounds are built by `createWard()`, including the additions. Automated tests preserve the central corridor, assert exact room/supply approach points are walkable before pathfinding, and verify the complete collision-free route to each point. They also check separation from original obstacle footprints, other additions and the initial eight tracked sample equipment meshes. This checks the current illustrative seed arrangement; arbitrary later manual inventory moves can still overlap decorations under the pre-existing slot planner.

The additions do not alter the original source references or claim new documentary evidence. No measured architectural, manufacturer or clinical validation has been performed. GPU performance on clinical workstations and accessible physical clearance beyond the viewer's 0.24 m navigation radius remain unvalidated.
