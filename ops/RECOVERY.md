# Disposable synthetic backup/restore exercise

Run only against an already approved local disposable PostgreSQL 16+ cluster with no operational
data, matching `psql`, `pg_dump` and `pg_restore` clients, and an existing local owner/superuser.
This script neither initializes a cluster nor creates credentials/grants. It does not use the
ingestion helper's temporary login/grant provisioning. It never accepts a service URL.

## Run the real drill

The cluster must already have `cluster_name=sv-ops-disposable` and listen on `127.0.0.1` using its
existing approved authentication. This marker is an accidental-target guard, not authentication;
the owner must confirm it is disposable and is not a proxy/tunnel to retained data. Do not mark
a retained or production cluster merely to make the check pass. Do not weaken its auth/RLS.
When starting an existing disposable cluster, its owner can supply the marker as a transient
startup option, for example `pg_ctl -D <existing-disposable-data-dir> -o "-h 127.0.0.1 -p 55439 -c cluster_name=sv-ops-disposable" -w start`.
Use the cluster's existing approved configuration; this is not permission to provision it here.

From the repository root in PowerShell, after the owner supplies the actual tool path and
existing local owner name:

```powershell
# Start a clean session without DATABASE_URL, PGSERVICE, PGSERVICEFILE, PGOPTIONS or PGHOSTADDR.
$env:PG_BIN = '<approved PostgreSQL bin directory>'
$env:OPS_PGHOST = '127.0.0.1'
$env:OPS_PGPORT = '55439'
$env:OPS_PGUSER = '<existing disposable-cluster owner>'
# If required, set PGPASSFILE to an existing protected local credential file; never print it.
node ops/recovery-drill.mjs --confirm-disposable-synthetic
```

Equivalent POSIX invocation (existing owner and approved binary directory required):

```sh
OPS_PGHOST=127.0.0.1 OPS_PGPORT=55439 OPS_PGUSER='REPLACE_WITH_EXISTING_OWNER' \
  PG_BIN='/path/to/approved/pg/bin' node ops/recovery-drill.mjs --confirm-disposable-synthetic
```

Exit 0 plus `state: passed` and confirmed cleanup are required for a native exercise pass.
Unavailable clients, mismatched major versions, connection/permission/marker errors, integrity
differences and cleanup failures return nonzero. Do not retry a permission denial through a
different directory, identity, binary route or host. Record the exact blocker. A test of the
integrity-comparison function is not a database backup/restore pass.

## Comparison failure diagnostics

A strict comparison failure retains the nonzero exit and generic failure message, followed by
`Recovery comparison diagnostics:` and one bounded JSON object. `phase` distinguishes
`post-restore` (before protection probes) from `post-protection-probes` (after the probe SQL has
returned). A phase identifies where comparison failed; it is not a successful drill or a pass for
an individual probe. An earlier fixture validation or SQL/tool failure may have no comparison
receipt. Do not infer completion of later stages from a missing receipt.

The receipt contains SHA-256 hashes of the complete before/after JSON snapshots and at most
eight mismatch entries, each with a structural `path`, `kind` and before/after subtree hashes.
Hashes use the existing JSON serialization, including key and array order; no comparison is
normalized or relaxed. Missing fields have a separate hashed presence marker. Paths contain
only fixed public schema/contract labels and numeric positions. Arbitrary object keys become
`property[n]` positions in that object's combined before/after key order; these positions are
not row identifiers and may require a separately approved local investigation to resolve.
No row values, SQL/function bodies, ACL values, tenant IDs, credentials or connection strings
are included in the comparison receipt. Hashes are diagnostic fingerprints, not encrypted data;
retain the receipt with the same care as other internal operational evidence.

Diagnostic traversal stops at depth 12 or 10,000 visited nodes; paths are at most 160 characters
and the JSON receipt is at most 8,192 bytes. `truncated: true` means the entries are incomplete
or a limit reports only a mismatching enclosing subtree. The strict full-snapshot comparison
still runs regardless of diagnostic limits. A cleanup failure keeps error priority and the safe
comparison receipt, while all existing database/archive cleanup attempts remain unconditional.
Do not disable strict checks or retain raw snapshots to make diagnosis easier.

The native attempt on 2026-11-09 at `1cf34f3e7503b30fafbaaa04cd8ef0d690306beb` failed with
`Restored data or security/schema metadata differs`. Matching PostgreSQL 18.6 tools completed
dump and restore before the failure. The historical output did not distinguish the two comparison
phases, so neither the exact differing field nor protection-probe completion is established.
Its finalized receipt confirms cluster shutdown and removal of the generated root and credential
files. This instrumentation does not reinterpret that failure or constitute another native run.
An instrumented rerun requires separate coordinator clearance and the approved disposable setup.

## What the script does

1. Checks explicit opt-in, non-production mode, loopback routing and safe existing username/port.
   Validates the explicit [migration inventory](recovery-inventory.mjs) against every
   `services/**/*.up.sql` file; missing/new migrations fail before a database connection or write.
   Finds existing tools through `PG_BIN` or PATH; checks the server marker, PostgreSQL 16+,
   existing superuser and matching client major versions before creating a database.
2. Creates `sv_ops_src_<random>` and `sv_ops_restore_<random>` using template0. All writes are
   confined to those generated databases. Applies unchanged core migration, synthetic seed,
   auth, equipment receipt, supply, request, holds, ingestion and location-resolution migrations.
   A synthetic legacy event precedes the receipt migration to exercise its key backfill.
   The remaining fixtures include a complete no-op response, two fractional stock transactions,
   the real `claim_request_item` SQL function, paired override/audit rows and independently stacked
   dirty/fault/maintenance/unknown holds. A cleared dirty hold remains beside its later active
   successor. Clearance invokes the actual SQL function with synthetic membership evidence.
   The dirty-to-supply-manager and fault-to-equipment-manager TEST mappings reuse the holds task's
   documented fixture conventions; maintenance/unknown are deliberately unconfigured. No mapping
   here is an operational default. Synthetic auth rows contain no credentials or tokens and create
   no database roles/grants. All are disposable
   SQL storage fixtures; they do not exercise HTTP or production identity. The policy values
   are explicitly synthetic and establish no operational defaults. Seed precedes forced RLS only inside this throwaway exercise;
   this does not repair or prove the independent SV-019 bootstrap path.
3. Captures every public table's complete rows in deterministic order and security/schema
   metadata. Makes a consistent custom-format `pg_dump` archive and restores into the separate
   empty target with `pg_restore --exit-on-error --single-transaction`. It preserves ownership
   and ACLs within that same disposable cluster; it does not use `--no-acl` or disable RLS.
4. Requires all 26 expected public tables and nonempty fixtures before archiving. Compares full
   row contents, identities, counts, physical/receipt timestamps, legacy/no-op receipt links,
   exact fractional stock-ledger/balance/version reconciliation, request assignments/events,
   override audit identity/policy/expiry, nonce evidence and hold history/actor/equipment/rule links.
   Hold summaries must remain blocked with all four independent active kinds while the prior
   cleared row and configured-role evidence survive. This fixture-specific check is not a general
   proof of historical clearance authorization: the holds schema does not version past rule changes.
   Security metadata includes RLS flags,
   table ownership/ACLs, policies, all indexes (including partial active-assignment uniqueness),
   constraints, triggers and function definitions/owners/ACLs/security settings. Runs rejected
   append-only mutations, duplicate replay/assignment inserts, stock-conflict rollback and the
   deferred override-audit FK check, then compares all data again. Hold probes reject deletion,
   rewriting and reactivation, wrong-role or unconfigured clearance, duplicate active kinds and
   new assignments with active holds. A successful single-kind clearance must leave the other
   holds blocking; that test clearance is rolled back before final comparison. Native protection
   probe completion remains unproven in the recorded failed attempt. Outputs aggregate SHA-256
   digests and checks, or the bounded comparison diagnostics above, never raw rows or connection errors.
5. Drops both generated databases, deletes the temporary archive directory, then reports success.
   If ordinary cleanup fails, output identifies exact generated resources for the cluster owner;
   no pass is claimed. An externally killed process may require that owner's cleanup of the
   `sv_ops_*` databases and `sv-ops-recovery-*` temp directory. Verify exact names and contents;
   never delete matching paths broadly. Stop the local cluster only if you own its lifecycle.

This uses a disposable superuser for fixture setup, dump/restore and assertions. It verifies
security metadata survives; it does **not** prove runtime-role authorization, managed identity,
hardware ingestion, HTTP readiness, point-in-time recovery, or a production restore. Re-run
unauthorized/cross-tenant HTTP tests using the actual unprivileged service before any cutover.
It does not downgrade or change any production RLS/auth policy.

The independent `node ops/recovery-inventory.mjs` command checks source coverage without any
native tools. Focused tests corrupt both sides of a snapshot deliberately: equal-but-incomplete
inventories, broken actor/key/reference links, stock balances, assignments and override bounds
must fail even when a naive before/after equality comparison would pass. These are local logic
tests, not evidence that the SQL fixtures, native dump/restore or cleanup have run successfully.

## Real backup policy and recovery gate

The DB owner must select managed backups/PITR or another approved strategy, define retention,
encryption, restricted access, region/residency, key recovery, backup age alerts and retention
testing. Agree RPO and RTO and measure an actual representative recovery before promising them.
Logical dumps alone do not provide PITR, global roles, provider settings or replication state.

Inventory every required recovery component: PostgreSQL data/schema, immutable observation and
nonce/receipt/dead-letter evidence, protected external rejection journal, migration/release
artifacts, identity/device configuration references and secret-manager recovery policy. Browser
localStorage is separate demo state, not the shared-record backup. Do not archive credentials
in Git or assume journal files are inside the database backup.

Before a real restore, stop or isolate writes under owner direction, select an approved recovery
point and restore into a separate isolated target using trusted archives. PostgreSQL restore
executes source database code; do not use untrusted dumps. Verify row/integrity checks, table
ownership/ACLs/RLS/function security, runtime membership boundaries, migration compatibility,
timestamp provenance and replay behavior. Reconcile committed writes after the recovery point;
lost nonce history can permit replays. Never clear replay evidence to fix ingestion. Obtain a
separate explicit cutover/data-loss decision, then rerun read-only and authorized synthetic smoke
checks and monitor. No real backup schedule, restore or cutover is configured by SV-017.
