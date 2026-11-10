# Database foundation (SV-004)

PostgreSQL 16+, tenant-scoped. Every table has `organization_id` and every cross-table reference includes it, so a row cannot point at another tenant's data. Synthetic data only.

## Local setup

macOS: `brew install postgresql@16`. Other systems: install PostgreSQL 16+ and set `PG_BIN` to its `bin` folder if it is not on `PATH`.

```sh
node services/api/db/cli.mjs local-start   # private cluster in services/api/db/.pgdata, port 54329
node services/api/db/cli.mjs migrate       # apply pending migrations
node services/api/db/cli.mjs seed          # synthetic NICU data (8 equipment, 10 locations)
node services/api/db/cli.mjs status        # list applied migrations
node services/api/db/cli.mjs local-stop
```

Use your own server instead with `DATABASE_URL=postgresql://user@host:5432/dbname`. `SV_PGPORT` and `SV_PGDATA` change the local port and data folder.

## Rollback and reset

```sh
node services/api/db/cli.mjs rollback      # undo the latest migration (add a number to undo more)
node services/api/db/cli.mjs reset         # roll everything back, migrate, reseed
```

Each migration runs in one transaction with its `schema_migrations` record. Migrations are `migrations/NNNN_name.up.sql` and `.down.sql`; every `up` needs a `down`. `seed` expects an empty database: run `reset` to reseed.

## What the schema enforces

- Tenant isolation through composite foreign keys; external keys and idempotency keys are unique per tenant.
- Equipment status, version, note length and observation source are constrained.
- `equipment_observation` and `equipment_event` are append-only (update and delete are rejected).
- A trigger on `equipment` requires administrative edits to raise `version` by exactly one, applies the same status transitions as `packages/domain/contracts.js` (retired is final), and refuses to move `last_verified_at` backward. Observations update location confidence without touching `version`.

## Seeding with row-level security (SV-019)

After the auth migration, row-level security is FORCED on the tenant tables, so even the table owner is subject to it, and no policy lets anyone create the first organization. `seed` therefore runs in ONE transaction as the table owner: it switches FORCE off for the tables that had it, loads the synthetic rows, switches FORCE back on, and checks it is on again. If anything fails, nothing is loaded and RLS is exactly as before. No policy, schema or runtime role changes, and the application's runtime role never gets a bypass. A role that does not own the tables fails with "must be owner". Running `seed` again does nothing.

Coverage: `tests/db.test.mjs` proves this on a real PostgreSQL cluster with a non-superuser owner. It is skipped when PostgreSQL is not installed. The embedded PGlite auth tests do not cover bootstrap.

## Tests

`npm test` runs `tests/db.test.mjs` against a throwaway cluster in a temp folder and removes it afterwards. Without PostgreSQL installed the database tests are skipped and say so.

## Limits

Row-level security, login and memberships belong to SV-005; supplies and replenishment tables to SV-009. The transition rules are duplicated in SQL and JavaScript and must be changed together.
