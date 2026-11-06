# SV-011 cleaning and maintenance

Scoped module, not a mounted production service. It reuses merged equipment commands/receipts, SV-001 transitions, SV-005 permissions/RLS, SV-012 audit queries and SV-020 active assignments. No migrations, new roles, grants to a real database, hold policy or shared host changes.

## Contract

Instantiate `createMaintenanceHandler({authorization})` from `routes.mjs` using the existing `createAuthorization({identityProvider, pool})`. Mount only its `/organizations/:org/maintenance/equipment` prefix in an authorized API composition. Its transaction client must use the existing READ COMMITTED contract, core/auth/receipt/request migrations and existing least-privilege runtime configuration. No bootstrap or dependency repair is supplied here.

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

`ready` means **available status and no active assignment in the currently merged model**, not a clinical release certificate. The SQL filters both before pagination in one statement snapshot. Cleaning, maintenance, in-use, retired and any unrecognized status cannot enter that view. Physical location freshness remains separate, including unknown/never-verified evidence. No new freshness threshold or borrowing policy is invented.

## Explicit policy/integration decisions still needed

SV-021 owns independent dirty/fault/maintenance/unknown holds and matching-role clearance; its role mapping is unresolved. The merged single-status schema cannot prove all independent holds are clear. Therefore this module cannot certify readiness or turn an unavailable item available when a service step finishes. Decide the hold/role policy separately before adding release. `equipment:write` is the existing coarse permission (operator/equipment manager/admin); history retains the existing `audit:read` permission without widening access for operators. There is no administrator bypass.

The shared equipment API/client's existing available-status search is unchanged: callers must deliberately mount and use this module's available-and-unassigned query until a separately coordinated shared search integration is approved. No claim is made that the shared app can reach this panel or handler. See the web module README for the exact handoff. SV-008's held seven shared web files, SV-019's reserved infrastructure and SV-021 are untouched.

## Verification

```sh
npm ci --prefix services/api/maintenance --ignore-scripts --no-audit --no-fund
npm test --prefix services/api/maintenance
node apps/web/maintenance/tests/browser-check.mjs
npm test
npm run check
```

Task-local PGlite 0.5.15 and DOM fixtures execute the actual authorization, RLS, equipment commands, receipts, audit and assignment schemas using synthetic records. All HTTP is in-process streams with no listeners. Ephemeral SQL roles/grants exist only inside the in-memory test database. These fixtures do not repair/reconstruct SV-019 bootstrap. Embedded parallel submissions are serialized by PGlite's single-connection lease; they are **not native multi-session concurrency proof**.

Offline installed-Chrome tests use `page.setContent` and an injected synthetic adapter, with no listener or live API. `CHROME_PATH` can select an installed executable. They verify native keyboard save/focus retention, history, desktop/narrow layout, reduced motion, no horizontal overflow and axe WCAG A/AA checks. They do not prove a mounted HTTP flow or manual screen-reader support. Screenshots are scoped under `apps/web/maintenance/evidence`.

Validation receipt and exact environment limitations: [VERIFICATION.md](VERIFICATION.md).
