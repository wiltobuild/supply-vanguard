# SV-017 operations preparation

These scripts and runbooks prepare an owner to evaluate a deployment. They do not deploy,
provision an account, issue a credential, assign grants, send alerts or establish service levels.
The repair integrates main `dd770606db334de80e40800506d9ab399af8c5cd`, including equipment
receipts, supplies, requests, stacked holds and location resolution. Reconcile the inventory against the exact
release commit: new or missing migration files block the drill rather than being silently omitted.

Root `npm run dev` serves static files on loopback port 4180. The merged shared equipment
client requires an existing authorized equipment API and does not persist equipment or credentials
in browser storage; initial connection failure must not substitute sample inventory. For the
documented local API proxy use [apps/web setup](../apps/web/README.md), with an existing loopback
API origin and already-issued synthetic session. This task supplies neither. `tools/serve.mjs`
does not mount the equipment API or ingestion handler and has no `/health` or `/ready` route. API auth/equipment
and provider-neutral ingestion are injectable modules. There is no production server entry,
managed identity verifier, hosting manifest, real sensor integration or installed alert collector.
The local identity/source verifiers reject production use. A static HTTP 200 does not certify
shared inventory, database access or current physical location.

## Reproduce local checks

Use Node 22+ (record the actual version), Git and the checked-in lockfiles. Root has no external
runtime dependencies; `npm ci` uses the root workspace lockfile. From a clean checkout:

```sh
node --version
npm --version
npm ci
node ops/environment.mjs --profile demo
node --test ops/tests/*.test.mjs
node ops/recovery-inventory.mjs
npm test
npm run check
npm run dev
```

Static files open at `http://127.0.0.1:4180`; functional shared inventory requires the separate
approved local API setup above. Use the equipment list as the non-WebGL fallback once connected.
Stop the foreground process with Ctrl+C. Static serving needs no operational data or secret. If `PORT`
is supplied, the existing server reads it. It does not automatically load `.env` files;
Node 22+ supports `node --env-file=ops/.env tools/serve.mjs` for an optional ignored local file.
Copy only `PORT` from [the example](.env.example) for that demo; keep connection settings separate.

The separate modules document their own pinned installs and verification:

```sh
npm ci --prefix services/ingestion --workspaces=false
npm test --prefix services/ingestion
npm run simulate --prefix services/ingestion
node ops/environment.mjs --profile integration
```

The ingestion commands start a disposable native PostgreSQL instance and temporary local
test identities; run them only where that separate module's documented local setup is approved.
They were not run as an alternative route around permission stops for this task.
See [auth setup](../services/api/auth/README.md), [DB lifecycle](../services/api/db/README.md),
[equipment routes](../services/api/equipment/README.md), and [ingestion](../services/ingestion/README.md).
The additive [supplies](../services/api/supplies/README.md), [requests](../services/api/requests/README.md)
and [location-resolution](../services/ingestion/resolution/README.md) modules retain separate
lifecycle and hosting contracts. The recovery inventory covers their merged migrations without
claiming that any module is mounted or production-ready.
The [holds module](../services/api/holds/README.md) depends on requests and ships no clearance-role
defaults. Fixture mappings are synthetic evidence only; organization owners must decide operational policy.
Root tests can fail without the independent auth-local PGlite dependency. SV-019 owns that
installation/test-loader repair, core seed/bootstrap and CI; this task does not install or
reconstruct its fix. On Windows the core DB helper also assumes Unix executable paths.
Record actual failures/skips; do not interpret skipped database tests as recovery evidence.

## Operator entry points

| Need | Procedure |
| --- | --- |
| Choose provider/region; promote or roll back | [Deployment and ownership](DEPLOYMENT.md) |
| Handle and rotate existing secrets | [Secrets procedure](SECRETS.md) |
| Check health, delay, stale equipment and errors | [Monitoring](MONITORING.md) |
| Rehearse synthetic recovery without production connections | [Recovery](RECOVERY.md) |
| Inspect this task's actual evidence and blockers | [Validation](VALIDATION.md) |

`ops/environment.mjs` checks local prerequisites only. `ops/monitor.mjs` evaluates an explicit
aggregate metrics file; it is not a collector. `ops/recovery-drill.mjs` uses existing PostgreSQL
clients and an existing marked local cluster, creates two uniquely named disposable databases,
then removes them and its archive. None accepts a production service URL.
`node ops/recovery-inventory.mjs` is read-only and needs no database: it checks the explicit
eight-migration inventory against every `services/**/*.up.sql` file and prints source hashes
and the expected 26-table count. A future migration requires an explicit reviewed fixture update.

## Deferred CI hook (SV-019)

No workflow, root dependency, auth, core DB, scene or app files change here. After the SV-019
owner resolves clean setup, that owner can review adding `node --test ops/tests/*.test.mjs`
and `node ops/environment.mjs --profile integration` to the existing check job. Recovery needs
a separately approved disposable PostgreSQL job with matching client binaries, existing local
owner and `cluster_name=sv-ops-disposable`; it must not inherit deployment credentials or access
production. Its nonzero result must fail that job, not be converted into a pass/skip. No CI
connection, schedule or new grants are configured by this PR.

References: [PostgreSQL SQL dumps](https://www.postgresql.org/docs/18/backup-dump.html),
[pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html),
[pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html),
[Node environment files](https://nodejs.org/api/cli.html#--env-filefile).
