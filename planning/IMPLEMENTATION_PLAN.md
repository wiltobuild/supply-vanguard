# Supply Vanguard implementation plan

## Selected UI/UX reference

The [homepage reference and shared design direction](../design/README.md) govern future UI work. Use the supplied department-workspace composition, coral accents, pastel equipment cards and large typography for the homepage, adapting its content to the working NICU scope. Carry shared tokens, navigation and components into equipment, ward, coordination and approval screens. SV-003 must implement this direction alongside accessibility and fallback requirements; saving this reference does not mark the redesign complete.

## Product and first release

Help staff find available equipment, understand whether its location is trustworthy, update movements and readiness, and replenish supplies. The 3D ward is a navigable representation of locations, not the source of inventory truth. Start with one Baltimore Children's Center NICU-inspired ward section: six infant rooms, supply room, equipment store, staff workroom and family area. Expand to additional wards only after location mapping and workflows are validated.

Primary users: bedside staff search and report moves; equipment staff clean, maintain and release equipment; supply staff replenish bins; managers monitor availability and audit changes; administrators manage users, facilities and integrations. Do not require patient identity for these workflows.

## What exists now

Runnable local web scaffold, reusable domain module, equipment register with eight synthetic assets, manual room/status updates, version checks, local event history, and equipment models/ID labels that move in the 3D scene. Existing orbit/walk navigation, supply demo, procedural geometry, GLB exports and reference documentation are imported intact. Twelve GLBs and vendored Three.js let another agent inspect and run the project without opening the original hosted Site.

The shared board is implemented separately on the remote task-board Git branch. Task claims use expiring leases and fast-forward updates; concurrent attempts cannot both claim the same task. Review state prevents work from being reclaimed while a PR is pending. Completion verifies a merged PR and requires another reviewer label. Repository write access is the security boundary; this is cooperative coordination, not identity enforcement.

## Architecture

Reuse the existing generated NICU ward and equipment asset kit in `packages/scene/viewer`: preserve the procedural `ward.js` and `models.js` source, the full ward and cutaway GLBs, and all ten individual equipment GLBs in `assets/` (12 GLBs total). Continue building on this scene and its configuration rather than regenerating or replacing it with an unrelated scene. Preserve stable room/location/equipment IDs and identity mappings, meters/Y-up coordinates, source labels and illustrative, non-surveyed provenance. Validate and refine the existing assets against approved reference evidence; any future geometry corrections must retain traceable source/confidence records and reviewed mapping changes.

Keep the web client, scene package and domain rules separate. A future API owns authoritative inventory state. The scene receives stable equipment IDs, location IDs, status, freshness and provenance; meshes are disposable render objects. Keep the list/search workflow fully usable without WebGL. Introduce a typed API contract before replacing the demo adapter.

Proposed production stack: current browser UI and Three.js initially, Node service and PostgreSQL, managed OpenID Connect authentication, migrations and CI. Provider selection, organizational access requirements and hosting region are decisions for the deployment milestone; no paid services are provisioned by this scaffold. Evaluate framework migration only if it simplifies required workflows; do not rewrite the scene to change UI frameworks.

Data entities: organization, facility, ward, location (hierarchical, stable external key), equipment type, serialized equipment, equipment observation, movement/status event, supply SKU, bin stock, stock transaction, replenishment task, maintenance job, user membership and integration source. Equipment is serialized; consumable quantities belong in stock transactions rather than duplicated equipment records. Store quantities in declared units. All server records carry tenant IDs and version/audit metadata.

Equipment commands validate allowed transitions, permissions and expected version in one database transaction, persist the new state and immutable audit event, and return conflict details on stale edits. Event records include actor/source, observed time, received time, correlation and idempotency keys. Realtime updates are notifications to refetch or ordered events, never a second authority. Preserve last verified location separately from last administrative edit: changing maintenance status must not falsely refresh physical location confidence (the demo currently uses one timestamp).

## Delivery sequence and acceptance gates

### 0 — Bootstrap (delivered)

Repo, local runnable demo, imported reusable 3D assets, full plan, seed backlog, concurrent claiming CLI, contributor instructions and checks. Gate: demo serves, models validate, domain and claim race tests pass, shared board is visible on GitHub.

### 1 — Contracts and trustworthy scene (SV-001–003, parallel)

Define versioned equipment/location/event schemas and source/freshness semantics. Extract ward configuration from procedural code, document meters/Y-up axes, map locations to coordinates, and validate bounds and asset references. Make equipment list workflows accessible, provide loading/error and WebGL fallback states, support narrow screens and keyboard use. Gate: unknown locations fail safely, every asset has a stable identity, and moving an asset updates both list and scene without changing identity. Preserve labels distinguishing verified sources from estimated geometry.

### 2 — Shared system of record (SV-004–008)

Build local development database, migrations, constraints, seed data and transaction tests. Integrate login and membership-scoped permissions. Add equipment query/update endpoints and immutable events with optimistic concurrency. Replace browser persistence with an adapter using API state; implement reconnect/refetch and conflict recovery. Add QR or barcode labels and manual check-in with source attribution. Gate: two clients see consistent changes, stale writes cannot overwrite newer state, unauthorized cross-tenant reads/writes fail, and duplicate check-ins are idempotent.

### 3 — Supply and equipment operations (SV-009–012)

Supply SKU/bin counts, adjustments and restocking as ledger transactions; low-par alerts and replenishment work queues; equipment cleaning/maintenance state transitions and availability filters; audit search/export. Gate: concurrent replenishment cannot double-add stock, maintenance assets cannot be presented as ready, every correction retains audit history, and exports obey permissions.

### 4 — Sensor integrations and confidence (SV-013–014)

Implement provider-neutral observation ingestion with device authentication, replay protection, idempotency, observed/received timestamps and dead-letter handling. Start with a simulator. Add one real RFID/BLE/RTLS provider only after hardware and access are chosen. Resolve late/out-of-order/conflicting observations using explicit rules and surface uncertain or stale locations. Do not infer precise coordinates from a room-level signal. Gate: replayed and delayed data cannot teleport equipment backward; offline devices show stale state, and manual overrides are audited and time bounded.

### 5 — Validation and production pilot (SV-015–018)

Obtain approved measured drawings or authorized measurements before claiming architectural accuracy. Review geometry and equipment placement with staff, maintaining a per-element source/confidence register. Add end-to-end tests, performance budgets, supported browser checks, backup/restore exercises, observability, deployment/rollback and operational runbooks. Run a limited ward pilot with synthetic data first, then approved operational data. Gate: staff can find/check in/replenish equipment, measured latency and errors meet agreed targets, restore and rollback are demonstrated, and known limitations are signed off.

## Targets to validate during pilot

Initial targets: useful scene within 5 seconds on the agreed ward workstation; responsive orbit at 30 fps or better; API p95 below 500 ms for routine queries; online updates visible within 5 seconds; no lost or duplicated committed inventory transactions. These are proposed acceptance targets, not current performance claims. Measure representative network, asset count and device conditions before committing service levels.

## Safety, access and operations

Use least-privilege memberships (viewer, operator, supply manager, equipment manager, admin), server-side authorization, scoped integration credentials and immutable audit records. Keep secrets outside source control. Define retention/export/deletion and backup policy with the deployment owner. Avoid patient-linked information in the first release. Production readiness and any organizational compliance requirements require their own review; the local demo is not a clinical decision system.

Validate imported JSON and scene boundaries, cap asset counts, and keep dynamic models separate from collision/navigation geometry. Add monitoring for ingestion delay, API errors, stale equipment and failed background jobs. Keep a documented recovery route when WebGL or live updates are unavailable. Add automated accessibility, conflict, authorization and integration replay tests where they verify real user outcomes.

## Coordination and next tasks

[Live board](https://github.com/wiltobuild/supply-vanguard/tree/task-board) is authoritative. The initial detailed tasks and acceptance criteria are in tasks.json. Agents claim only ready tasks, heartbeat leases, use isolated branches and submit PR evidence. Dependencies unlock only after reviewed completion. First parallel opportunities: domain contracts, scene configuration, accessible web experience, and database foundation. Board mutations use Git pushes with conflict checks; never manually overwrite live tasks.json from the seed.

Major unresolved decisions: partner collaborator identity; actual floor-plan access and reuse rights; pilot hardware/workstations; identity provider and hosting; RTLS vendor; barcode format; retention and operational ownership. None blocks the delivered local scaffold or independent ready tasks.
