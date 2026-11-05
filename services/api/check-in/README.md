# Attributed check-in API (SV-008)

This task-local handler consumes the merged auth, equipment and domain interfaces. It creates no competing server/auth layer. Task-specific changes are confined to `services/api/check-in` and `apps/web/check-in`. The branch integrates main `f18d8967895b2c9ae52fea96a26f80e821640233`, including the merged PR #12 equipment repair; pending PR #13 shared web/API wiring is not imported.

## Integration contract

Apply `migrations/0001_check_in.up.sql` as the migration owner **after** the existing core and auth migrations. As part of the existing runtime-role provisioning, grant `SELECT, INSERT, UPDATE ON public.check_in_receipt` to the application's existing non-owner, non-superuser, `NOBYPASSRLS` runtime role. Do not grant deletion or change audit policies. This directory does not edit the shared migrator, seed/bootstrap or runtime-role setup (SV-019 owns those files).

Mount `createCheckInHandler({authorization})` from `routes.mjs` for exactly `/organizations/:organizationId/check-ins` and `/organizations/:organizationId/check-ins/locations` in the host's existing dispatcher, using its existing `createAuthorization` instance. The dispatcher/migration integration remains with the shared entry-point owners; no shared files are modified here.

- `GET .../check-ins/locations` returns `{items:[{id,name,kind}]}` from the current tenant's known SQL locations.
- `POST .../check-ins`, `Content-Type: application/json`, `Idempotency-Key: <1..80 identifier characters>`, optional bounded `X-Correlation-Id`.
- Body: `{equipmentId, locationId, observedAt, source}`. IDs are case-sensitive bounded ASCII identifiers; observedAt is a real UTC ISO instant; source is `manual-check-in`, `barcode` or `qr`. Extra fields, including actor/tenant/received-time overrides, are rejected. Body cap: 2048 bytes.
- Both routes require a freshly verified active membership with `equipment:write`; write authorization is checked before body parsing and again in the write transaction. Unknown equipment yields 404, invalid input/location/future observation yields 400, unauthorized requests yield 401/403, and a changed-key request or actor collision yields 409. Responses are JSON with `Cache-Control: no-store` and safe existing error mapping.
- First success: 201 and `{record,applied,reason?,replayed:false,observation}`. Exact authorized retry: 200 with the **original** snapshot and times, `replayed:true`. `observation` contains equipment/location, actor, source, observed and server-received timestamps. An older valid observation remains history, with `applied:false`, without overwriting newer verified location.

## Transactions, identity and limitations

An actor-private, tenant-keyed SQL receipt reserves the exact normalized request. A competing same-key insert waits on the unique constraint before reading the committed original result. Another actor sees no private receipt and gets a conflict. Reused keys with a different equipment/location/source/time/correlation are rejected. Tenant namespaces remain separate. Membership/user revocation is respected before replay; audit SELECT permissions remain unchanged.

The reservation, existing `recordObservation()` SQL, equipment state, immutable audit event and original result receipt share one authorization transaction. Any validation/conflict/write error rolls everything back. Receipt identity/request cannot change and a completed result is immutable. Observation keys use `check-in:<request key>`; their existing event keys are `observation:check-in:<request key>`. A colliding observation without a receipt is a 409, never an attributed success for a different request.

The wrapper first locks **only** the equipment row, then calls the existing observation service for a fresh joined read. Merged PR #12 now also locks equipment independently inside that service; both locks occur in the same authorization transaction. This task does not modify the shared repair or claim a new native verification of it. Receipt replay does not call the observation service a second time.

The private receipt design is specific to interactive check-in; do not use it as an ingestion provider or an audit export. No persistent credentials, production accounts, hardware integrations or hosted services are provisioned. Test identities and inventory are fictional/synthetic. Record provenance is preserved unchanged, and administrative version/status timestamps are not refreshed by physical observations.

## Verification

The disposable fixture applies the merged equipment receipt migration in one explicit transaction after core/auth, then creates the task-local receipt schema. Its `sv_check_in_runtime` fixture role receives only `SELECT, INSERT` on `equipment_command_receipt`; tests verify UPDATE/DELETE remain ungranted and forced RLS remains enabled. Administrative PATCH and check-in retries are exercised together after later observations and administrative edits, checking original snapshots, verified actor and unchanged history/receipt counts. These are temporary fixture grants, not application provisioning changes.

```powershell
npm ci --prefix services/api/check-in --ignore-scripts
npm test --prefix services/api/check-in
# Optional explicit native mode in an environment authorized to initialize a disposable cluster:
$env:CHECK_IN_BACKEND='native'
# On non-Windows set CHECK_IN_PG_BIN to a native PostgreSQL bin directory.
npm test --prefix services/api/check-in
# Optional actual loopback HTTP transport (default is in-process request/response streams):
$env:CHECK_IN_HTTP='network'
```

Default tests execute the real HTTP handler, auth boundary, equipment service, domain rules and actual SQL migrations/policies in serialized PGlite. In-process HTTP streams avoid needing network access. DOM/scanner tests use jsdom and controlled media objects; those tests do not establish physical device or browser-layout behavior. The native lock-wait case explicitly skips in PGlite. Native mode uses a new loopback-only disposable PostgreSQL cluster, independent pg connections and a native lock-wait assertion, then stops/deletes only that test cluster. Windows native binaries are an optional test dependency; no runtime dependency is added to the application.

Current run evidence and blockers are recorded in `VERIFICATION.md`. Root auth test loading, root dependency wiring, bootstrap repair, native detection and CI files are reserved to SV-019 and remain unchanged. No upstream artifact was transferred, recreated or bypassed.
