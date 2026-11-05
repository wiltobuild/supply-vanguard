# Ward reference evidence — SV-015

**Authorized geometry validation is blocked. No element is measured or approved.**
This package records what the existing illustrative scene asserts, the limits of
its public references, and the exact evidence still needed for an authorized review.
It does not change the scene or claim architectural, surveyed, navigational or
current operational accuracy. No external people were contacted.

`register.json` is the reviewable source/confidence register. The baseline is
main commit `603442d9cc7b0900049967f56376b522089005f0`; public references were
read on 2026-11-05. This is a desk review of public material and repository
provenance, **not an authorized facilities or ward-staff review**. See the original
[accuracy notes](../REFERENCE.md#accuracy) and [viewer provenance](../viewer/data.js).

## What is registered

| Coverage | Classification | Meaning |
|---|---|---|
| 10 rooms, including six infant rooms | Estimated / unverified | Synthetic identities, numbers, areas, centers, doorways and adjacencies |
| 9 supply locations | Estimated / unverified | Cabinet/cart coordinates, room assignments and approach points |
| 10 equipment models | Estimated / unverified | Representative shapes, GLB bounds, makes and placement assumptions |
| Envelope, six-room layout, procedural architecture, navigation and equipment slots | Estimated / unverified | All remaining dimensions, walls, windows, doors, ceilings, finishes, fixed furnishings, obstacles and clearance assumptions |
| Coordinate system | Convention / declared | Meters, Y up and equipment +Z; geographic north unverified |
| 5 public-source feature claims | Qualitative | General inspiration only; never dimensional or placement evidence |

Each element carries a stable ID, model-value snapshot, classification, source,
scope and limitation. Zero elements have measured status. Numeric room areas,
dimensions and exported mesh bounds are values of the authored model, not
measurements of an actual ward. Synthetic inventory quantities are not geometry
evidence. The procedural architecture group covers details without stable mesh
instance IDs; its exact `ward.js` revision is pinned, rather than pretending that
each procedural object has been individually surveyed.

Twenty artifact digests cover executable geometry/configuration, navigation,
reference metadata and all twelve GLBs. A text digest normalizes CRLF to LF for
cross-platform checkouts; GLBs use raw bytes. Any artifact change fails the check
until a reviewer examines the affected evidence and updates the register. Digests
establish which model was reviewed, not whether the model matches reality.

## Public-source desk review

| Source | Supported scope and locator | Explicit limit |
|---|---|---|
| [Hopkins NICU parent guide (2024)](https://www.hopkinsmedicine.org/-/media/johns-hopkins-childrens-center/documents/specialties/neonatal-medicine/a-parents-guide-to-the-nicu-english-2024.pdf) | Printed pp. 7–8: sleep chair and family facilities; pp. 17–20: representative equipment | No dimensions, brands, current room mapping or modeled placement |
| [Hopkins NICU design article (2012)](https://www.hopkinsmedicine.org/news/articles/2012/07/nicu-design-with-less-movement-in-mind) | Historical eighth-floor context, private rooms and family amenities | Does not establish current layout or six-room configuration |
| [Hopkins patient-room design](https://www.hopkinsmedicine.org/johns-hopkins-childrens-center/patients-and-families/bloomberg-childrens-center/patient-rooms) | Noise-reduction list: NICU rubber floors and building-wide decentralized workstations | No NICU workstation coordinates or dimensions |
| [Public Bloomberg tower map](https://www.hopkinsmedicine.org/-/media/hse/maps/bloomberg-tower-north-south.pdf) | Single-page building context | Not verified as a dimensioned eighth-floor NICU plan; no tracing, scale, orientation or adjacency validation |
| [Perkins&Will project description](https://perkinswill.com/project/the-johns-hopkins-hospital-sheikh-zayed-tower-and-the-charlotte-r-bloomberg-childrens-center/) | Building-wide circulation/design context; completion 2012 | No verified NICU section drawing or measured geometry |

No source imagery or floor-plan content is redistributed. Online availability
does not grant permission to republish architectural documents. These public
sources have `dimensionalEvidence: false`; numerical claims cite the illustrative
local scene only, preventing qualitative corroboration from inflating confidence.

## External block and resolution evidence

The repository contains no approved measured drawings, measurement access,
current location crosswalk or authorized staff/facilities approval. The live board
must retain the external block until the owner provides evidence and a reviewer
resolves it. A code review of this package cannot sign off the ward geometry.

The `validation.requiredEvidence` entries specify five unresolved inputs:

1. **Permission:** owner-approved access/reuse scope and an approved storage,
   redaction and retention route for drawings or an authorized measurement visit.
2. **Measured geometry:** current drawing/survey identity, revision, floor/section,
   units/scale, date, measurement method and uncertainty; boundaries, room sizes,
   openings, corridor widths, ceiling heights, fixed fixtures and coordinate anchors.
   The owner must agree tolerances; none are invented here.
3. **Location mapping:** an approved crosswalk from synthetic IDs to real locations,
   verified names/numbers, adjacency and orientation; confirm or replace the six-room
   assumption through a reviewed migration.
4. **Equipment placement:** approved dimensions/models and ward-staff review of
   actual storage, fixed equipment, placement and workflow clearances. A model's
   exported bounds do not meet this requirement.
5. **Authorized review:** dated approval references from facilities/reference-owner
   and ward staff, tied to evidence revisions and exact model commit, per-element
   comparisons, discrepancies, agreed tolerances and remaining limitations.

Keep restricted evidence in the owner's approved store. Commit only approved,
redacted references/identifiers and the necessary comparison results. Do not add
patient data. Record the authorizing role and evidence reference without requiring
personal names in this public-style register. Obtain user approval before contacting
external people.

Once evidence is available, renew/reclaim through the board workflow, compare
each affected field with its source, record deviations and resolve them with the
authorized reviewers. Preserve estimated status for unmeasured fields. Schema 1
intentionally represents this blocked baseline only: adding measured status or
authorized sign-off requires a reviewed schema/validator change that checks linked
evidence, field-level results and approval references. Changing a status string
cannot satisfy acceptance.

## Verification

Run from the repository root with Node.js 22+; no installation or network needed:

```sh
npm test
npm run check
node --test packages/scene/references/register.test.mjs
node packages/scene/references/validate.mjs
node packages/scene/references/validate.mjs --require-authorized
```

The root suite does not discover this scoped test file automatically; run its
explicit command. The reference consistency command exits **0** only when coverage,
classification and artifact checks pass, and prints the external block. Invalid or
stale evidence exits **1**. `--require-authorized` exits **2** for the expected
unresolved authorization/measurement gate. This is deliberately distinct from a
passing consistency check. Automated checks do not verify physical dimensions,
staff usability, current configuration, permissions or approval authenticity.
