# Supply Sentry — NICU asset kit

A self-contained, explorable reference reconstruction inspired by the Baltimore Johns Hopkins Children's Center NICU. Six private infant rooms, clean supply, staff workroom, equipment storage and family lounge. Original representative equipment; no patient data.

## Open the walkthrough

With Node.js installed, run `npm run dev` from this folder, then open http://127.0.0.1:4173. All browser dependencies are included under `dist/vendor`; no network or npm install is required to view it. Opening index.html directly with file:// is not supported by browsers' module security rules.

Overview: drag to orbit, scroll to zoom, select room labels or stock markers. Walk: WASD or arrow keys, drag to look, click the floor to navigate. Touch movement buttons appear on touch devices. “Walk here” computes a path through the modeled door openings. “3D asset library” isolates each model and offers GLB downloads. Stock edits are explicitly simulated and saved to this browser only; reset from the supply overview.

## Deliverables

- `dist/assets/nicu-ward.glb`: full-height ward, removable ceiling meshes, named rooms and supply objects.
- `dist/assets/nicu-ward-cutaway.glb`: low-wall cutaway version with ceiling meshes omitted. Use the source for dynamic switching.
- Ten individual GLB files: incubator, warmer, monitor, infusion, recliner, supply-cabinet, supply-cart, workstation, sink, stool.
- `manifest.json`: dimensions, asset bounds, triangle counts, provenance and source links.
- `locations.json`: stable room/location/item IDs and sample inventory.
- `navigation.json`: estimated X/Z obstacles, room destinations and spawn.
- `dist/models.js` and `dist/ward.js`: editable procedural source.

## Accuracy

This is not an as-built or surveyed digital twin and is not an official Johns Hopkins product. Public references establish private rooms, family sleep chairs, rubber flooring and distributed work areas. The six-room section layout, all dimensions, room numbering, cabinet positions, equipment makes and quantities are estimates or illustrative choices. Sources span 2012–2024 and do not establish the current configuration. The public Bloomberg map was not verified as a dimensioned eighth-floor NICU plan, so this model is not traced from it. The model's north indicator is a coordinate convention, not verified geographic north. See the viewer's Sources & accuracy panel and `manifest.json` for references.

## Integrating into Supply Sentry

Everything uses meters, Y up. Individual equipment faces +Z. Retain stable IDs in `locations.json` and GLB node extras. Room names and inventory are synthetic. Model geometry is separate from inventory state.

Use a GLTFLoader to load an individual file or the assembled ward, or import the procedural modules into a Three.js project. If importing those modules from React, they can be used with React Three Fiber's primitive object support. The core module has no React dependency.

The included viewer exposes:

```js
window.SupplySentry.getInventory(); // deep copy
window.SupplySentry.selectLocation('CS-A');
window.SupplySentry.navigateToLocation('CS-A');
window.SupplySentry.setQuantity('CS-A', 'gloves-xs', 8);
window.SupplySentry.resetInventory();
document.addEventListener('supply-sentry:location-select', e => console.log(e.detail));
document.addEventListener('supply-sentry:inventory-change', e => console.log(e.detail));
document.addEventListener('supply-sentry:navigation-complete', e => console.log(e.detail));
```

Supply your inventory adapter in place of sample data and localStorage when the app exists. No clinical system, account, external inventory API or backend is connected. Route geometry is illustrative and intended only for this modeled scene.

## Rebuild and validation

`npm install`, then `npm run assets` regenerates the GLBs and bundled Three.js browser files. `npm run check` checks all room/supply destinations, clear navigation paths, stable IDs, finite geometry and GLB containers. `npm run dev` serves `dist/` locally.

Three.js is pinned to 0.187.0 and distributed under its MIT license (included in `dist/vendor/THREE-LICENSE.txt`). Equipment geometry and simple wall accents were created for this project. Public Hopkins photos, branded artwork and logos are referenced, not redistributed as textures. “Johns Hopkins” identifies the reference institution, not an affiliation.
