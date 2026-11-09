# SV-011 cleaning and maintenance

Scoped module with an approved shared-shell integration; no deployed/production service claim. It reuses merged equipment commands/receipts, SV-001 transitions, SV-005 permissions/RLS, SV-012 audit queries, SV-020 active assignments and the merged SV-021 hold overlay. No migrations, new roles, grants to a real database or hold policy changes.

## Contract

Instantiate `createMaintenanceHandler({authorization})` from `routes.mjs` using the existing `createAuthorization({identityProvider, pool})`. Mount only its `/organizations/:org/maintenance/equipment` prefix in an authorized API composition. Its transaction client must use the existing READ COMMITTED contract, core/auth/receipt/request/holds migrations and existing least-privilege runtime configuration. No bootstrap or dependency repair is supplied here.

| Route | Existing permission | Result |
| --- | --- | --- |
| `GET /organizations/:org/maintenance/equipment?view=cleaning&limit=25&cursor=...&q=...&location=...` | `inventory:read` | `{items,nextCursor}`; view is cleaning (default), maintenance, all or ready. Stable external-ID ordering, limit 1–100. |
| `POST /organizations/:org/maintenance/equipment/:id/service` | `equipment:write` | `{record,changed,replayed}`, body `{action,expectedVersion,note?}`, mandatory `Idempotency-Key` up to 88 characters. Optional bounded `X-Correlation-Id`. |
| `GET /organizations/:org/maintenance/equipment/:id/history?limit=25&cursor=...` | `audit:read` | Administrative events, newest first with exact microsecond cursor; before/after notes and status, actor/source and provenance retained. |

Actions:

- `start-cleaning` / `start-maintenance`: only from merged available/in-use statuses, and only when the existing transition contract allows it. Existing unavailable statuses cannot be replaced with another service phase here.
- `record-service`: change an administrative note while status is cleaning/maintenance; nonblank note up to 500 characters. A completed step **leaves status unavailable**. Notes preserve physical location and last-verified evidence. Repeating the current note is a receipted no-op with no extra event/version, following the merged command contract.
- No release, finish-to-available, hold clearance, assignment release, retirement override or supplied role/actor/location/status fields. Unknown actions/fields are rejected.

The command locks equipment first, checks an actor-private namespaced receipt before transient state/version rules, then delegates the normalized command to the actual merged `updateEquipment`. Equipment, immutable admin event and receipt commit atomically under `authorization.run`. The retry must retain target, body, expected version and key; replay returns its original snapshot, so the client refetches current truth. Keys use `admin:maintenance:<client-key>` in existing event/receipt storage. Cross-target/body/actor collisions cannot apply another mutation. No patient information belongs in notes.

`ready` means **available status, no active assignment and no active equipment hold**, not a clinical release certificate. The SQL filters all three before pagination in one statement snapshot. Any active dirty/fault/maintenance/unknown hold excludes the asset even though the hold leaves equipment status/version unchanged. Clearing only one of several holds does not make the item eligible. Inactive hold rows remain history and do not themselves block an otherwise eligible asset. Cleaning, maintenance, in-use, retired and any unrecognized status cannot enter that view. Physical location freshness remains separate, including unknown/never-verified evidence. No new freshness threshold or borrowing policy is invented.

## Explicit policy/integration decisions still needed

Merged SV-021 supplies independent dirty/fault/maintenance/unknown holds and organization-configured matching-role clearance. It ships without a default mapping: an unconfigured kind cannot be cleared, and an administrator has no special exception. This module reads the hold overlay under existing `inventory:read` RLS; it adds no hold placement, clearance or configuration action. Service steps never change holds or turn unavailable equipment available. `equipment:write` remains the existing coarse permission (operator/equipment manager/admin); history retains the existing `audit:read` permission without widening access for operators. No operational role mapping is introduced here.

The shared shell's available counts/search now use this module's canonical ready query and the shared connection. Inventory/ready are separate reads: the client rejects mismatched ID/version/available status and never falls back to status-only availability. The exact seven shared paths were admitted by coordinator migration203; unrelated SV008/check-in and SV019 reservations plus SV021 source/policy remain untouched. In-process mounted flows pass; actual supported mounted-browser acceptance remains with the coordinator.

`createEquipmentMaintenanceHandler({authorization})` in `dispatch.mjs` routes to the unchanged public equipment handler or this maintenance handler, using one injected authorization/pool/verifier. Malformed request targets are mapped to400 rather than escaping the composite listener. `createWebHandler({apiHandler})` provides a same-origin injection point without introducing a server/auth implementation; injected sync/async failures are mapped to generic500. The separate test-only `preview.mjs` imports the existing shared fixture for the manager's authorized runtime, never production provisioning. Its first listening attempt succeeded with actual shell and authenticated API HTTP200; see the shared web README for the controlled start contract and cleanup. Actual supported-browser acceptance remains with the coordinator.

## Host prerequisites and fail-closed behavior

Use the existing migration lifecycle: core, auth, equipment command receipts, requests, then `services/api/holds/migrations/0001_holds.up.sql` (holds requires core/auth/requests). The existing non-owner, NOBYPASSRLS runtime must already have its approved inventory/assignment reads plus **SELECT on `equipment_hold`**; hold reads use the existing tenant-scoped `inventory:read` policy. This module does not provision a runtime, widen memberships, install a clearance rule or apply a persistent grant. Any runtime setup belongs to its separately authorized owner.

Do not mount this readiness query against an older status-only schema or silently ignore a missing hold table/read privilege. Missing holds schema or SELECT privilege produces a generic500 with no ready items, rather than falling back to optimistic readiness. The migration and read privilege are tested as prerequisites in the in-memory fixture. Querying readiness does not update equipment, assignments or hold history and does not authorize allocation; the existing assignment transaction still decides atomically.

## Verification

```sh
npm ci --prefix services/api/maintenance --ignore-scripts --no-audit --no-fund
npm test --prefix services/api/maintenance
node apps/web/maintenance/tests/browser-check.mjs
npm run check
# This retained environment's full root npm test includes previously denied Git/socket/native stages.
# Do not rerun those here. Permitted repository subset:
node --test tests/additional-assets.test.mjs tests/contracts.test.mjs tests/domain.test.mjs tests/glb-equivalence.test.mjs tests/location.test.mjs tests/scene-config.test.mjs tests/web.test.mjs
```

Task-local PGlite 0.5.15 and DOM fixtures execute the actual authorization, RLS, equipment commands, receipts, audit, assignment and holds migrations using synthetic records. Hold-query fixtures grant only SELECT on holds to their ephemeral runtime; trusted fixture arrangements create active/cleared history without introducing a runtime clearance role or policy. All HTTP is in-process streams with no listeners. Ephemeral SQL roles/grants exist only inside the in-memory test database. These fixtures do not repair/reconstruct SV-019 bootstrap. Embedded parallel submissions are serialized by PGlite's single-connection lease; they are **not native multi-session concurrency proof**.

Offline installed-Chrome tests use `page.setContent` and an injected synthetic adapter, with no listener or live API. `CHROME_PATH` can select an installed executable. They verify native keyboard save/focus retention, history, desktop/narrow layout, reduced motion, no horizontal overflow and axe WCAG A/AA checks. They do not prove a mounted HTTP flow or manual screen-reader support. Screenshots are scoped under `apps/web/maintenance/evidence`.

Validation receipt and exact environment limitations: [VERIFICATION.md](VERIFICATION.md).
