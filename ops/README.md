# SV-017 operations preparation

These scripts and runbooks prepare an owner to evaluate a deployment. They do not deploy,
provision an account, issue a credential, assign grants, send alerts or establish service levels.
The current main baseline is `5e1100cae690f001fa4964bb73f52479598f6e75`. Reconcile this record
against the exact release commit: open feature PRs are not available contracts.

The runnable product is the loopback browser demo (`npm run dev`, port 4180). It stores
synthetic equipment changes in the browser. `tools/serve.mjs` serves static files, not the
equipment API or ingestion handler; it has no `/health` or `/ready` route. API auth/equipment
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
npm test
npm run check
npm run dev
```

The demo opens at `http://127.0.0.1:4180`; use its equipment list as the non-WebGL fallback.
Stop the foreground process with Ctrl+C. No operational data or secret is needed. If `PORT`
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
