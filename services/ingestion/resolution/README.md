# Location resolution (SV-014)

This additive service resolves **current recorded evidence** from merged SV-001/006/013
contracts. It does not connect to hardware, implement a timeline, change the equipment API,
mount an HTTP route, move a scene mesh, or mutate equipment location/status/version/confidence.
The host explicitly calls this projection; existing equipment API consumers continue to use
their existing contract until a separately reviewed integration adopts it. All tests are synthetic.

## Host contract

```js
import {createLocationResolution} from './index.mjs';
const resolution = createLocationResolution({authorization, policy: approvedPolicy});
const projection = await resolution.get({request, organizationId, equipmentId});
// equipmentId/locationId here are existing database UUIDs, not browser external keys.
await resolution.override({request, organizationId, equipmentId, idempotencyKey, body: {
  locationId, observedAt, expiresAt, reason, correlationId
}});
```

Supply the existing `createAuthorization` using its non-owner, NOBYPASSRLS runtime pool.
`get` requires existing `inventory:read`; overriding requires existing `equipment:manage`
(currently equipment_manager/admin). This is a conservative reuse of existing management
authority, not a new role or business approval policy. Operational owners must approve that
mapping before hosting. No memberships, auth functions, core migrations or general audit policies
are modified. An operator/viewer cannot override or retry a manager's override. Read access to
general `equipment_event` and override audits still requires existing `audit:read`.

No freshness/conflict/override duration defaults are provided. `approvedPolicy` must explicitly
contain exactly `{version, freshMs, staleMs, conflictWindowMs, maxOverrideMs}` in milliseconds.
They are safe integers, nonnegative, `staleMs >= freshMs`, and `maxOverrideMs > 0`. Select and
version these values with the operational owner before use; they are not clinical thresholds.
Policy version and all values are recorded in override audit evidence. Current projection
freshness uses the host's current policy; changing it can change a read's classification. A
policy change does not extend or retroactively shorten a previously recorded override's bounds.

The domain implementation lives in `packages/domain/location/index.js`. Its input evidence
retains observation ID, tenant/equipment/location IDs, observed and received UTC instants,
source kind and source ID, actor, correlation and idempotency keys. The SQL adapter reads
`ingestion_receipt.source_id` when visible to the current role. For observations without a
visible ingestion receipt (including manual producers and viewers), source ID is explicitly
`null`; it is never inferred from the actor or vendor name. Existing receipt visibility is
unchanged. No credentials, proofs or raw vendor payloads are returned or retained here.

## Deterministic current-state rules

1. Only observations physically observed **and received** by the server evaluation instant
   participate. `observedAt <= receivedAt` is required. The server supplies evaluation/start time.
2. The latest **observed time** is the watermark. Later receipt never advances it. Consider all
   observations within `conflictWindowMs` of that watermark, inclusive. This window deliberately
   treats rapid contradictory moves as uncertain until newer unambiguous evidence clears it.
   With a zero window only equal-observed-time contradictions conflict. No vendor/manual source
   is silently ranked above another observation source.
3. Different locations in that window produce `state: uncertain`, `locationId: null`, and explicit
   candidate IDs/locations/provenance. A delayed contradictory reading may add uncertainty; it
   cannot replace the watermark with an older room. Same-location ties agree. Evidence is ordered
   ascending by observed time, then received time, then stable ID using code-point ordering.
   The latter two ordering keys provide reproducibility, never evidence of source authority.
4. Exact duplicate IDs are deduplicated. Changed content for an existing ID, or a different ID
   claiming the same tenant idempotency key, fails closed. Intake still owns durable replay and
   key collision handling; this is an additional projection integrity check.
5. `freshness` is `fresh` through `freshMs`, `aging` through `staleMs`, then `stale`, measured only
   from physical observed time. Uncertainty and freshness are independent: a conflict may also
   be stale. A stale known room remains last recorded evidence, never a guarantee of current
   position. No evidence is `unknown` with no location, even when administrative equipment
   `location_id` is populated. Status/note/admin timestamps never enter this calculation.

The SQL adapter reads candidate observations and the latest override in one MVCC statement,
so a read cannot mix snapshot pages. An ingestion commit after that snapshot appears on a
subsequent call. There is no projection write to race or move a stored location backward.
The host must refetch this capability when evidence changes; no realtime delivery is added.
The technical `maxEvidence` cap defaults to 1,000 (host-configurable 1..10,000). Overflow
throws `503 resolution-evidence-limit` rather than truncating away a possible conflict or
claiming confidence. This is a resource bound, not a clinical/business threshold.

## Audited, time-bounded manual precedence

An override is an explicit manual attestation for one tenant/equipment/location, carrying a
physical `observedAt`, a **server** `startsAt`, and caller-requested `expiresAt`. Observed time
cannot be after the start; expiry must be after the start and within approved `maxOverrideMs`.
Backdated attestations retain their age; recording an override does not refresh physical time.
Later overrides cannot regress the previous override's observed-time watermark.

Within the half-open interval `[startsAt, expiresAt)`, the attested location takes precedence;
sensor candidates and contradictions remain visible in the projection. Freshness still ages
from the attestation, so an active override can itself be aging or stale. Overlapping overrides
conflict (`409 active-override`); there is no silent replacement, cancellation or renewal API.
At expiry normal sensor resolution resumes only if evidence has a strictly newer observed time
than the attestation. Otherwise the result is unknown (`expired-override`), preventing an older
sensor reading from teleporting the item back. A new authorized attestation is a new command.

The append-only audit stores verified user ID, tenant, reason, correlation/idempotency keys,
server time, complete applied policy and before/after projection snapshots. Minimal override
facts are separate from reason/actor/audit snapshots so inventory reads do not grant audit access.
Both rows commit in the same authorization transaction. A deferred FK prevents override facts
from committing without an audit partner. Update/delete triggers and forced tenant RLS protect
both tables. A failed audit insert rolls back the override; no success is returned on audit failure.

Transaction advisory locks serialize tenant/idempotency key and then tenant/equipment. Identical
retries bind to verified tenant, user, equipment and exact normalized command and return the
original stored snapshot, including after intervening input/expiry/policy changes, without a
new audit or extended deadline. Changed payload/actor/target conflicts. Membership is rechecked
before every retry. Host errors are `ResolutionError(status, code)`; unexpected errors should
map to a generic unavailable response without SQL, credentials or internal error text.

## Provider-neutral boundary

`createVendorAdapter` in `vendor-adapter.mjs` accepts trusted server configuration:
`{organizationId, sourceId, source, decode, equipmentIdForTag, locationIdForZone}`. `decode`
implements vendor parsing/authentication as appropriate and returns only
`{readingId, tagId, zoneId, observedAt, correlationId?}`. Mapping callbacks receive the configured
tenant and must return existing authorized UUIDs or null. Unknown mapping fails; no new ward,
equipment, location, precise coordinates or inferred movement is created. Source is explicitly
one of `rfid`, `ble`, `rtls`, `simulator`; configuring a source label does not prove hardware exists.

`normalize(payload)` yields `{organizationId, sourceId, observation}`. A deterministic key hashes
configured source ID plus stable vendor reading ID. Retrying the same reading is idempotent;
changing its content under that key conflicts at ingestion. The normalized result contains
neither actor nor received time. The trusted host must create a fresh nonce/transmission time
and sign the **whole** envelope using its provisioned verifier mechanism, then call the unchanged
SV-013 `ingest`. Source/tenant authentication, membership, replay, reference validation and receipt
stamping still happen there. Normalization alone never accepts an observation. No permissive
verifier, production credential setup or concrete hardware vendor is supplied.

## Migration and verification

Apply core/auth/ingestion first. Call `migrateResolution(ownerClient, 'up')` from `migrate.mjs`
using a deployment-owned connection. It is transactional, lock-protected and repeatable. It
creates only the two task-local tables. Grant the existing runtime role `SELECT, INSERT` on
`location_override` and `location_override_audit`, plus its existing equipment/location/observation/
ingestion receipt SELECT and auth EXECUTE grants. RLS applies even with table grants. The module
checks forced RLS and rejects table-owner runtime connections. It creates no roles or credentials.
`down` destroys override evidence and is only appropriate for disposable local test databases;
reapplying requires restoring dropped table grants. No automatic retention/pruning is supplied.

```sh
npm ci --prefix services/ingestion --workspaces=false
node --test tests/location.test.mjs
node --test services/ingestion/resolution/tests/resolution.test.mjs
npm test --prefix services/ingestion
npm test
npm run check
```

The root location suite is pure deterministic domain/adapter coverage. The separate native suite
uses the unchanged ingestion local bootstrap, PostgreSQL 18.6, non-owner runtime connections,
real ingestion and RLS. It checks delayed/conflicting input, administrative independence,
freshness, source normalization, role/tenant isolation, audited expiry/replay/rollback and migration
lifecycle. The identical-key race explicitly holds a native advisory lock and observes at least
two backend sessions waiting before release. Different-key competition is also tested. These
tests are not PGlite or a serialized repository fake. Native startup can fail on restricted
Windows initdb/loopback permissions; root clean-install PGlite-loader failures belong to SV-019.
Record the actual execution results rather than treating an unavailable stage as a pass.

Operational policy approval, provider/hardware selection, bounded retention, production hosting,
HTTP/UI adoption, alerting and scene integration remain separate decisions/work. No patient data
or live tracking is used, and no historical replay correctness is asserted by this current projection.
