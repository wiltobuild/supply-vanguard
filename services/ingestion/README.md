# Observation ingestion simulator (SV-013)

Provider-neutral immutable intake using the existing observation contract and tenant authorization.
All new implementation, dependencies, migrations and tests live in this directory.
No changes to the equipment API, auth, core schema/seed or root configuration are required.

The synthetic simulator records room-level observations of the existing NICU inventory. It does
not connect to RFID/BLE/RTLS hardware, invent coordinates, alter the existing ward/GLBs, or update
equipment location/status/version/last-verified fields. SV-014 owns location/conflict resolution.
Delayed observations remain historical evidence; receipt time never refreshes physical freshness.

## Local setup and verification

Node 22+, Git and an ordinary local OS account are required. From the repository root:

```sh
npm ci --prefix services/ingestion --workspaces=false
npm test --prefix services/ingestion
npm run simulate --prefix services/ingestion
npm test
npm run check
```

The pinned `embedded-postgres` development dependency supplies PostgreSQL 18.6. Integration tests
and the simulator start a disposable native cluster on an available loopback port, use separate
owner and non-owner runtime logins with random temporary passwords, and remove the cluster after
an orderly `pg_ctl` shutdown. They create no OS users, hosted services or durable credentials.
Initialization uses the unchanged core migration and synthetic seed **before** applying forced
RLS, followed by unchanged auth and task-local ingestion migrations. Runtime requests always use
the separate `NOSUPERUSER NOBYPASSRLS NOINHERIT` role; owner connections are only local setup/assertions.
The bootstrap refuses production mode and requires explicit `development` or `test` mode.

On this Windows desktop native `initdb` cannot rename its own WAL files in the restricted sandbox;
native tests/simulator require the authorized desktop execution environment outside that sandbox.
Linux must run this helper as an ordinary user; it deliberately refuses to create a system user
for root. A missing/unsupported binary or failed native startup fails tests rather than skipping.
The task-local dependency installation does not install the separate auth package's PGlite tests.
Root clean-install/auth test behavior is tracked by the independent SV-019 repair owner.

## Hosting adapter

`createIngestion({authorization, verification, rejectionJournal, now?, replayWindowMs?})` returns
`ingest({request, organizationId, envelope})`. Supply the existing `createAuthorization` capability,
using a safe non-owner database pool. Every request, including a duplicate, requires an active
membership with `equipment:write`. Caller role/user/tenant claims never grant access. Database
RLS enforces the selected tenant on core and ingestion tables; cross-tenant reference IDs are
reported like nonexistent IDs. Runtime refuses privileged roles or missing/unsafe RLS tables.

`verification.verify({request, envelope})` is an injectable, **trusted server adapter**. It must
authenticate the entire envelope (including nonce, transmission time and observation), and return
`{sourceId, organizationId, userId, source, actor}` from trusted provisioning, or null on failure.
Organization and user must exactly match the authorized transaction, source ID must match the
envelope, and the observation's source must match verified provenance. Provider exceptions fail
closed and are journaled as ingestion failures. No default permissive verifier is provided.

`createLocalSourceVerifier` is a trusted local/test-only adapter. `provision` returns an in-process
signer backed by a short-lived, random HMAC key; it exposes no key, HTTP issuance endpoint or
credential file. It only verifies loopback requests and emits `simulator` provenance. The separate
existing local identity provider supplies short-lived membership sessions. Both source and
membership revocation apply to retries. Production identity/device provisioning is a later task.

`createIngestionHandler(ingestion)` handles `POST /observations?organizationId=<tenant UUID>` with
`application/json`, a 16 KiB body limit and no-store responses. It is an injectable HTTP handler,
not a hosted service or a replacement for the equipment API. No socket is opened by its import.

The signed envelope has this shape (all records and IDs below are illustrative/synthetic):

```json
{
  "schemaVersion": 1,
  "sourceId": "synthetic-nicu",
  "nonce": "unique-transport-attempt",
  "sentAt": "2026-11-05T16:00:00.000Z",
  "observation": {
    "schemaVersion": 1,
    "equipmentId": "00000000-0000-4000-8000-000000000011",
    "locationId": "00000000-0000-4000-8000-000000000031",
    "observedAt": "2026-11-05T15:59:00.000Z",
    "source": "simulator",
    "idempotencyKey": "synthetic-reading-001",
    "correlationId": "optional-synthetic-correlation"
  },
  "proof": "adapter-specific-proof"
}
```

Only UTC timestamps with millisecond precision are accepted. `receivedAt` and `actor` are set by
the server; caller-supplied values are rejected. The shared `validateObservation` contract checks
the resulting record. Invalid dates, unsupported fields, non-UUID references and future physical
observations fail validation. Database lookups then establish reference visibility/existence.

## Replay, idempotency and transaction guarantees

- `sentAt` must be within the last five minutes (inclusive) and cannot be in the future.
  `observedAt` may be arbitrarily old: offline history retains its original observation time.
- `(tenant, verified source ID, nonce)` is unique and durable. Resending an identical envelope is
  a replay (`409`); it cannot insert a second observation. Signed malformed attempts retain their
  consumed nonce and a dead letter after source/window checks.
- For a legitimate retry, use a fresh nonce/signature/transmission time with the same observation
  and idempotency key. An exact semantic duplicate returns `200` with the original observation ID
  and received time. It does not insert a second observation or refresh receipt/physical timestamps.
- A changed payload, authenticated user, actor or source with an existing tenant key conflicts
  (`409`). A key already used by another core observation producer also conflicts; no unverifiable
  prior observation is adopted as a successful receipt.
- A PostgreSQL transaction advisory lock serializes concurrent requests for a tenant/key. Nonce,
  core observation and immutable receipt commit together. An unexpected failure rolls them all
  back, records a safe external failure digest, and permits a genuine retry after recovery.
- Intake does not apply a location projection or produce a movement event. New and late accepted
  observations remain immutable input for the separate resolver. Administrative state stays intact.

Expected responses include `201 accepted`, `200 duplicate`, `409 replay/replay-window/idempotency-conflict`,
`400 malformed`, `401 unauthenticated`, `403 forbidden/unauthorized-source`, and `404 unknown-reference`.
Unexpected database/verifier/journal failures return HTTP `503 ingestion-unavailable`; internal
messages, tokens, signatures and tenant-existence details are not exposed.

## Rejections and dead letters

Authorized tenant requests retain append-only `ingestion_dead_letter` evidence: server receipt
time, authenticated user, tenant, a bounded reason code and a SHA-256 envelope digest. Raw bodies,
signatures and credentials are deliberately absent. These records are evidence for investigation,
not automatic replay instructions. Reading tenant dead letters requires `audit:read`; write access
alone does not expose the audit trail. Receipt/dead-letter inserts must name the authorized user.
Correct a rejected record, then submit a freshly signed envelope;
never mutate evidence. Native SQL constraints and RLS protect these tables.

Before a tenant is authenticated (or on transaction failure), the required external
`rejectionJournal` retains only `{receivedAt, reason, envelopeDigest}`. No caller-claimed tenant is
trusted. `createFileRejectionJournal(privatePath)` supplies an append-only local NDJSON sink; the
operator must secure its path/ACL, collect it and set retention for a real deployment. The local
fixture deletes its journal with the disposable cluster. Invalid JSON, media type and oversized
HTTP bodies also leave journal evidence. For oversized HTTP requests the digest covers only the
bounded buffered prefix, not the entire oversized body. Failed journal writes propagate as errors;
the service never claims that unrecorded evidence was retained. There is no silent fallback sink.

No nonce/evidence pruning is automatic. Retention/backup, source rotation, quotas/rate limits,
device provisioning, operational dead-letter tooling and one chosen hardware provider remain
deployment/integration work. Keeping nonce rows prevents replay after restart; no in-memory nonce
cache is treated as the authority.

## Local migration lifecycle

For an **existing local development database** with core and auth applied, set `DATABASE_URL` in
the environment and use `npm run migrate --prefix services/ingestion -- up` (or `down`). Migration
is transactional, lock-protected and repeatable. It creates/drops only the three ingestion tables;
it never creates a role, changes shared auth policies, or rewrites the core migration history.
Down intentionally removes ingestion receipts/nonces/evidence; use only on disposable local data.
Reapplying requires restoring runtime grants because dropped tables lose their ACLs.

The local database owner must grant the chosen existing runtime role `SELECT, INSERT` on
`ingestion_nonce`, `ingestion_receipt`, `ingestion_dead_letter` and `equipment_observation`, plus
the existing auth execution/read grants and `SELECT` on equipment/location. There are no runtime
update/delete policies on ingestion evidence. No migration assumes a production role name.

## Acceptance tests

The task-local suite runs against native PostgreSQL 18.6 with independent pooled connections:
HTTP → membership → source verification → RLS → committed observation/receipt; unauthenticated,
malformed, cross-tenant and spoofed requests; source/session revocation; replay windows and exact
replay; historical freshness; source/key collisions; immutable evidence; rollback recovery; and
task-local migration down/up. The concurrency test holds an actual database lock, confirms at
least two backend sessions waiting concurrently in `pg_stat_activity`, releases the lock, then
asserts one observation and one accepted result. Conflicting keys and identical-nonce races are
also tested. These are native transactional assertions, not a serialized fake/PGlite pool.
