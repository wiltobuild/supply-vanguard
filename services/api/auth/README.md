# Authentication and authorization (SV-005)

This module binds a verified identity to an active database user and an active organization membership. Roles come from the database on every request, so revocation and role changes apply to existing sessions. Organization selection is untrusted input and must match a membership. Administrators are scoped to their organization too.

The identity provider is unresolved. The included provider is an explicit **local development boundary**: random opaque bearer tokens, hashed in memory, 15-minute expiry, revocation, and loopback-only verification. Tokens disappear on process restart. There is no public issuance endpoint, password store, signup, cookie, or durable credential. `NODE_ENV=production` rejects this provider. Do not use real identities or patient details in local bootstrap data.

## Verify locally

From the repository root (Node 22+):

```sh
npm ci --prefix services/api/auth --ignore-scripts --no-audit --no-fund
npm test
npm run check
# Auth tests only:
npm test --prefix services/api/auth
```

Auth tests always run against PGlite 0.5.15, an embedded PostgreSQL engine, using in-memory synthetic records and a non-owner `NOSUPERUSER NOBYPASSRLS NOLOGIN` test role. No external database or credentials are created. The HTTP tests bind an ephemeral loopback port. Core SQL is applied unchanged except for its unused `CREATE EXTENSION pgcrypto` statement: PGlite already provides the `gen_random_uuid()` used here. These tests exercise actual SQL policies, rather than mocking query filtering. Native PostgreSQL 16+ checks in `tests/db.test.mjs` retain their existing skip behavior when PostgreSQL is absent.

Coverage includes missing/expired/revoked tokens, unknown issuer/subject, forged headers, all role/permission pairs in JavaScript and SQL, two tenants, cross-tenant reads/updates/deletes/inserts, admin tenant isolation, missing context, rollback and pooled-connection reuse, disabled users/memberships, privileged-connection rejection, and migration rollback/reapply.

## Role matrix

| Permission | Viewer | Operator | Supply manager | Equipment manager | Admin |
| --- | --- | --- | --- | --- | --- |
| inventory:read | Yes | Yes | Yes | Yes | Yes |
| equipment:write | | Yes | | Yes | Yes |
| equipment:manage (create/delete) | | | | Yes | Yes |
| supplies:write | | | Yes | | Yes |
| audit:read / audit:export | | | Yes | Yes | Yes |
| organization:manage | | | | | Yes |
| membership:manage | | | | | Yes |

Unknown roles and permissions deny. Supply and membership permissions reserve the application contract for subsequent handlers; this task adds no supply tables, public membership-provisioning route, or self-service role grants. Membership/user writes require a separately trusted operator process. `equipment:write` is a coarse database permission; command-specific transitions, optimistic concurrency and atomic audit transactions remain SV-006. Observation/event update and deletion remain forbidden by both RLS and the existing append-only triggers.

## Database lifecycle

After applying the core migrations, use the existing local development database URL:

```sh
node services/api/db/cli.mjs migrate
# Set DATABASE_URL using the existing local database configuration, then:
node services/api/auth/migrate.mjs up
```

Auth migrations live here to keep this task isolated. They do not change core migration history, create database roles, assign account access, or create credentials. Each up/down runs in one transaction under an advisory lock and rejects duplicate application/removal. Roll auth back **before** core rollback/reset:

```sh
node services/api/auth/migrate.mjs down
node services/api/db/cli.mjs rollback
```

The existing native database CLI currently assumes Unix executable paths. Windows users can run it in their existing PostgreSQL-enabled development environment or apply the up/down SQL files in a transaction with their existing PostgreSQL client. No database installation is needed for the embedded auth tests.

## Server integration contract

```js
import {createAuthorization, writeAuthError} from './auth/index.mjs';
import {createLocalIdentityProvider} from './auth/local-identity.mjs';

const identityProvider = createLocalIdentityProvider({mode: 'development'});
// Trusted bootstrap only: provision matching synthetic auth_user and auth_membership records
// using an existing operator connection. No roles are accepted from HTTP or token claims.
const temporaryToken = identityProvider.issue('synthetic-operator');
// Hand this short-lived token to a local test client; never log or persist it.
const authorization = createAuthorization({identityProvider, pool: existingRuntimePool});

// In a server route, organizationId comes from the route, not a trusted client assertion:
try {
  const rows = await authorization.run(request, {
    organizationId, permission: 'inventory:read'
  }, async context => {
    return (await context.query(
      'SELECT id, name FROM public.equipment WHERE organization_id = $1',
      [context.organizationId]
    )).rows;
  });
  // Return rows using the route's normal response format.
} catch (error) { writeAuthError(response, error); }
```

`pool` follows the node-postgres pool interface (`connect`, exclusive client `query`, `release(error)`). All work must be awaited inside the callback on that client, never on `pool.query` or a second connection. The callback gets the immutable verified user ID, organization ID and current role. Its query capability expires when the callback finishes. Handlers are trusted server code; never accept raw SQL, transaction commands, role changes, or session settings from clients. Parameterize client values. SQL RLS is defense in depth against missing tenant filters, not a sandbox for hostile SQL.

Each run verifies the identity, begins a transaction, rejects superuser/BYPASSRLS/table-owner connections or disabled RLS, resolves the user, sets transaction-local identity/tenant context, checks membership and permission, and commits or rolls back. Failed rollback discards the pooled connection. Missing database context yields no tenant rows. Expected auth errors return generic 401/403 JSON; internal errors return generic 500, with no token or SQL details.

Before using the adapter, the deployment owner must configure an existing separate runtime role with **NOBYPASSRLS**, no ownership/membership in table-owner roles, no schema CREATE, no DDL/TRUNCATE/role-management privileges, and least-privilege table grants. It needs SELECT on `auth_user`/`auth_membership`, EXECUTE on `auth_resolve_identity(text,text)`, and only the core table operations exposed by approved handlers. The fixed-search-path identity resolver is the sole SECURITY DEFINER function; it must remain owned by the trusted migration/table owner. It returns only an active user ID for an exact issuer/subject match. No direct user/membership mutations are granted to the runtime role. This PR does not apply new security permissions to an account.

## Production limitations

Production requires a reviewed managed OIDC verifier implementing `verify(request) -> {issuer, subject}` with signature, trusted issuer, audience, expiry/not-before and key-rotation checks. Token-supplied roles or tenant memberships must still be ignored. Define TLS, session transport, logout/revocation policy, rate limits, security monitoring and approved membership provisioning with the deployment owner. None is simulated by the local provider. Existing browser demo persistence and the generated NICU scene/12 GLB assets remain in place; connecting the browser and production equipment endpoints belongs to later tasks.

References: [PostgreSQL row security](https://www.postgresql.org/docs/16/ddl-rowsecurity.html), [PGlite docs](https://pglite.dev/docs/).
