# Bloomberg 9 North cardiac step-down concept — SV-026

This is a usable, original **eight-bay illustrative section**, not the measured floor plan of Johns Hopkins Hospital. Run the repository with `npm run dev`, then open `/ward/wards/pcu/index.html`. Use `/ward/wards/pcu/index.html?view=list` for the same synthetic equipment records without importing Three.js.

## Evidence reviewed on 5 November 2026

| Public source | What it supports | What it does not establish |
| --- | --- | --- |
| [Hopkins: A New Progressive Pediatric Cardiac Care Unit](https://www.hopkinsmedicine.org/news/articles/2021/10/a-new-progressive-pediatric-cardiac-care-unit), 11 October 2021 | Historical opening of a progressive pediatric cardiac unit on the Children's Center ninth floor; ambulatory telemetry | Current dimensions, room count, arrangement, furniture positions or full equivalence to today's 9 North service |
| [Hopkins careers: pediatric cardiac step-down, transplant and general care](https://jobs.hopkinsmedicine.org/job/103658/registered-nurse-pediatric-cardiac-step-down-transplant-and-general-care-unit-nursing-us-md-baltimore-johns-hopkins-hospital/), requisition 682547 | Identifies Bloomberg 9 North and describes a 20-bed service | A count of rooms, a measured plan, census, current stock or equipment availability |
| [Hopkins nursing: pediatric-neonatal ICUs](https://www.hopkinsmedicine.org/nursing/specialties-units/pediatric-neonatal-icu) | NICU at Bloomberg 8 North, PICU at 4 South | Room mapping, shared elevators, direct vertical overlap or a validated travel route |
| [Hopkins: Patient Rooms](https://www.hopkinsmedicine.org/johns-hopkins-childrens-center/patients-and-families/bloomberg-childrens-center/patient-rooms) | Building-wide private pediatric rooms, baths, family sleeping accommodations and decentralized workstations | Ward-specific geometry or contemporary finishes on 9 North |
| [Public patient-room photograph linked on that page](https://www.hopkinsmedicine.org/-/media/johns-hopkins-childrens-center/images/general-images/patient-room-2.jpg) | Visually inspected: blue walls and seating, white bed, bedside monitor and an illustrated shade | The photograph is not labeled as 9 North. It is a qualitative building reference only; no dimensions can be derived reliably |

The floor labels establish a one-floor-level difference from the NICU in the same named building. Proximity is an inference from that information, not a verified physical route. This is the **step-down / general-care** concept; it is distinct from the pediatric cardiac intensive care unit (PCICU).

The source photograph is linked, not copied, rehosted, used as a texture or reproduced with people in the scene. Window decoration is original abstract geometry. No restricted plans, patient records or nonpublic imagery were accessed.

## Authored choices and missing evidence

All eight bays (A1–A4 and B1–B4), both support spaces, the 32 × 18 meter model footprint, 3.6 meter corridor, 6.5 meter bay widths, 2.85 meter wall height, door openings, bath enclosures, windows and furnishings are **inferred demonstration geometry**. These values describe the software model only. The eight bays do not purport to recreate the full reported 20-bed service. The labels are synthetic and have no crosswalk to actual room numbers. Axis orientation is a software convention and is not true hospital north.

The blue palette, family chairs, private-bath alcoves, headwalls and distributed charting ledges are qualitative design interpretations. Equipment type, manufacturer, count, readiness and positions are not verified. The interface labels every record as a synthetic example and makes no operational stock, borrowing or tracking claim.

Missing evidence: approved current dimensioned plans; authorized room/door/location mappings; current ward-specific interior references and reuse authorization; actual equipment specifications and inventory; facilities and ward-staff validation. No clinical or architectural sign-off is claimed. These gaps block claims of fidelity, not use of this expressly illustrative preview.

## Integration and model reuse

- Ward ID: `pcu-bloomberg-9n`. Locations and equipment use independent `pcu-*` IDs; no NICU identities are remapped. Units are meters, Y up.
- `config.js` is the stable source for rooms, examples, public references and collision rules. `ward.js` builds disposable geometry. `viewer.js` owns graphics and navigation. `app.js` renders accessible records independently of WebGL and catches graphics/import failure.
- Existing `../../models.js` is imported unchanged for infusion pump, monitor, supply cart, recliner, sink, workstation and cabinet. The original 12 GLBs, NICU files and shared manifests are unchanged. The generic bed is a local fixture made from original primitive geometry; it has no manufacturer or dimensional accuracy claim.
- Shared ward selector/navigation is owned by SV-025. This standalone PR has working NICU and workspace return links and no link to an unmerged PICU route. After both PRs are reviewed, the shared selector can expose this stable route. No implementation-plan, root dependency, CI or API edits belong to this task.
- The 26 example records are static, browser-local demonstration data. No API requests, data persistence, room changes, clinical workflows, borrowing decisions or real location observations are added.

## Use and verify

Overview: drag to orbit, scroll to zoom, toggle cutaway, reset view. Search by type, ID or illustrative room. Filtered examples receive blue ground rings; selection receives a coral ring. The list is the accessible alternative to clicking meshes. Room buttons and selected-model controls enter a safe, collision-checked viewpoint; focus the canvas to walk with W/A/S/D or arrow keys, drag to look, and Escape to return. Touch controls support walking. Keys clear on blur, tab hiding and mode changes. The roof remains hidden in interior mode to keep this concept readable; it is not a ceiling simulation.

Local geometry tests (no added dependencies):

```sh
node --import ./packages/scene/viewer/wards/pcu/tests/register.mjs --test packages/scene/viewer/wards/pcu/tests/pcu.test.mjs
npm test
npm run check
```

`tests/three-loader.mjs` only maps the existing vendored Three.js module for Node geometry tests. Tests cover identity isolation, existing model kinds and finite bounds, safe room entry/corridor clearance, collision tunneling, search results, and return/fallback paths. See `VERIFICATION.md` for the actual run and browser evidence. Screenshots describe the authored concept only, never an exact image of the hospital interior.
