# Deployment, rollback and ownership

This is a reviewable procedure, not a deployment authorization. The release owner must first
name actual people and complete [the decision record](examples/deployment-record.json), without
putting credentials or private contact information into Git. Unset decisions block a hosted pilot.

## Decisions and responsible roles

| Decision | Accountable role | Evidence required before pilot |
| --- | --- | --- |
| Provider, account, region and data residency | Deployment owner with organization approver | Explicit provider/region selection, permitted data classes, network/TLS, costs and approved provisioning scope |
| Service build, routes and release | Service owner | Reviewed production entry point, immutable artifact/commit, routing and graceful shutdown; static server is insufficient |
| Database lifecycle, access and recovery | Database owner | PostgreSQL version, distinct migration/runtime identities, permission review, retention, encrypted backups, restore rehearsal and chosen RPO/RTO |
| Identity and device verification | Security/identity owner | Managed OIDC verifier, issuer/audience/key rotation, revocation behavior, device provisioning and rejection journal policy |
| Monitoring and incident response | Incident primary plus backup | Working collection, threshold approval, alert destinations/coverage, escalation and acknowledgment exercise |
| Equipment freshness and safe fallback | Ward operational lead | Agreed verification threshold, manual verification/escalation process and staff training |
| Pilot acceptance | Release owner and ward operational lead | Synthetic end-to-end evidence, known limitations and an explicit go/no-go decision |

The builder/board owner `wil` is a coordination label; it is not an on-call assignment or
organizational sign-off. Fill actual primary/backup roles in the owner's approved operational
system. If either responder is unavailable, defer deployment. A page/chat destination and response
times require agreement; this repository establishes none and sends no messages.

## Environment preparation

1. Record the exact reviewed commit and previous known-good commit, Node version, PostgreSQL
   major version, lockfile hashes and build artifact identity. Start from a clean isolated checkout.
   Run the checks in [README](README.md), retaining failures and database skips in the release record.
2. Choose the provider/region and a separate synthetic staging environment after authorization.
   Document TLS termination, private DB connectivity, connection limits, storage capacity, resource
   limits and log destination. No existing provider, port mapping or production manifest is implied.
3. Assemble the service using the current `createAuthorization`, `createEquipmentHandler` and
   `createIngestionHandler` contracts. Use reviewed managed identity/source adapters, a non-owner
   `NOBYPASSRLS` runtime pool and a durable protected rejection journal. Reject startup if required
   configuration/verifier/journal is absent. Do not enable the local verifier in production.
4. Have the DB owner review migrations in core → auth → ingestion order. Existing commands are:
   `node services/api/db/cli.mjs migrate`, `node services/api/auth/migrate.mjs up`, and
   `npm run migrate --prefix services/ingestion -- up`. Each uses its documented prerequisites;
   auth/ingestion take an existing `DATABASE_URL`. The core helper's native path discovery is
   Unix-oriented. These are lifecycle references, not a hosted bootstrap recipe.
5. Keep synthetic seed (`services/api/db/seed/seed.sql`) restricted to an empty disposable local
   DB. Do not seed a pilot with operational data or run root reset on a retained database.
   SV-019 owns the unresolved seed-after-forced-RLS/bootstrap repair. The recovery fixture's
   seed-before-auth order is not evidence that this shared bootstrap works.
6. Existing access/grants require a separate reviewed owner procedure. This task creates none.
   Reconcile equipment service operations and ingestion table SELECT/INSERT needs with the auth
   read/execute requirements. No runtime DDL, table ownership, superuser or BYPASSRLS privileges.
7. Inject secrets through the chosen secret manager, using [SECRETS](SECRETS.md). Verify that
   production bundles, logs, browser storage, diagnostics and metrics contain no privileged key.

## Readiness and controlled release

The service owner must implement readiness at the actual server boundary; there is no delivered
health endpoint to configure today. Distinguish process liveness from readiness to receive
authorized inventory traffic. Readiness should require a bounded DB round trip, expected migration
fingerprint, safe runtime-role/RLS configuration, usable verifier configuration and writable
rejection evidence sink. Keep detail private; a public health response must not disclose tenant,
credentials or SQL. Document dependency timeouts and how readiness removes an instance from traffic.

Before promotion, run synthetic authorized read/update/observation and replay tests through the
assembled staging HTTP service. Test unauthenticated, revoked, wrong-role and cross-tenant failures,
conflict recovery, durable evidence, restart and stale/unknown display. A static demo response or
an imported handler test alone cannot pass this gate. See [MONITORING](MONITORING.md).

Verify the selected backup can restore to isolation with integrity evidence; measure time and
data-loss bounds under the proposed policy. Agree rollout size, observation window, abort signals
and decision owner before changing traffic. Roll out the exact immutable artifact, verify its
revision and configuration reference, then re-run smoke checks. A release owner explicitly accepts
remaining limitations; the task board's review state is not that acceptance.

## Rollback procedure and limits

1. Incident primary records the affected revision, first symptom, last successful operation and
   safe correlation IDs. Stop promotion and disable further risky ingestion/writes via the reviewed
   service/traffic mechanism if integrity is uncertain. Do not relabel stale equipment as verified.
   Ward staff use the equipment list/manual physical verification and their approved escalation
   process; the illustrative scene cannot establish that an item is physically available.
2. Release owner and DB owner decide whether the previous artifact is compatible with the current
   schema and records. If compatible, use the chosen provider's reviewed traffic/artifact rollback
   command and existing config reference. Record the actual command in the release record when the
   provider is selected; there is no universal executable deployment command in this repository.
3. Re-run private readiness, authorized smoke, rejection-evidence and fresh telemetry checks on
   the rolled-back revision. Reconcile in-flight accepted requests using durable idempotency keys,
   receipts and observations; never blindly replay dead letters or delete nonces to recover service.
4. If schema or semantics are incompatible, keep traffic stopped or degraded and choose a reviewed
   forward fix or isolated database recovery. Code rollback does not undo committed equipment
   events, observations or a physical equipment move. Restore to a separate target, verify all
   data and security, reconcile writes since the recovery point, and obtain owner approval for any
   cutover/data loss. A file checksum alone is insufficient.
5. Preserve incident evidence, record the recovery point/actual duration and the decision to
   resume traffic. Revoked or compromised secrets stay revoked; do not restore old secret values
   from a previous configuration or backup.

Core `rollback/reset` and auth/ingestion `down` are destructive local tools, not safe production
rollback. Ingestion down drops receipts, nonces and dead letters, and reapplication loses runtime
table ACLs. Auth down removes the authorization layer. Neither belongs in automatic rollback.
Database backup does not include browser localStorage, external rejection files, device/OIDC
secrets, provider configuration or global roles. See the recovery inventory before any cutover.

## Escalation decisions

Escalate authorization leakage or suspected credentials to the security owner immediately using
the owner's approved channel, while disabling affected access through that owner's process.
Escalate restore/integrity/RLS mismatch to the DB owner; ingestion gaps/journal failures to the
service/integration owner; stale/unknown locations and operational workarounds to the ward lead.
The incident primary coordinates these decisions and the backup takes over if needed. When the
cause or ownership is unclear, the release owner holds promotion and keeps the limitation visible.
No response-time promise is made until staffed coverage and alert delivery are demonstrated.
