import {AuthError} from './errors.mjs';
import {permits, ROLE_PERMISSIONS} from './roles.mjs';
export {AuthError} from './errors.mjs';
export {ROLE_PERMISSIONS, permits} from './roles.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// pool.connect() must return an exclusive query-capable connection with release().
// All authorization and work use this same transaction; settings never leak to the next request.
export function createAuthorization({identityProvider, pool}) {
  if (typeof identityProvider?.verify !== 'function' || typeof pool?.connect !== 'function') throw new Error('Identity verifier and database pool required');
  return Object.freeze({
    async run(request, {organizationId, permission}, work) {
      const identity = await identityProvider.verify(request);
      if (!identity || typeof identity.issuer !== 'string' || !identity.issuer || typeof identity.subject !== 'string' || !identity.subject) throw new AuthError(401, 'unauthenticated');
      if (!uuid(organizationId) || !Object.values(ROLE_PERMISSIONS).some(list => list.includes(permission))) throw new AuthError(403, 'forbidden');
      const client = await pool.connect();
      let begun = false;
      let discard;
      try {
        await client.query('BEGIN');
        begun = true;
        const safety = await client.query(`SELECT r.rolsuper OR r.rolbypassrls OR EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname IN ('auth_user', 'auth_membership', 'organization', 'facility', 'ward', 'location', 'equipment_type', 'equipment', 'equipment_event', 'equipment_observation')
          AND (NOT c.relrowsecurity OR pg_has_role(current_user, c.relowner, 'USAGE'))
        ) AS unsafe FROM pg_roles r WHERE r.rolname = current_user`);
        if (safety.rows[0]?.unsafe !== false) throw new Error('Unsafe runtime database role or missing row security');
        // Resolve only the verified issuer/subject. Client user IDs, roles and tenant claims are ignored.
        const principal = await client.query('SELECT public.auth_resolve_identity($1, $2) AS id', [identity.issuer, identity.subject]);
        const userId = principal.rows[0]?.id;
        if (!uuid(userId)) throw new AuthError(401, 'unauthenticated');
        await client.query("SELECT set_config('sv.user_id', $1, true), set_config('sv.organization_id', $2, true)", [userId, organizationId]);
        const memberships = await client.query('SELECT role FROM public.auth_membership WHERE user_id = $1 AND organization_id = $2 AND active', [userId, organizationId]);
        const role = memberships.rows[0]?.role;
        if (!permits(role, permission)) throw new AuthError(403, 'forbidden');
        // Scoped capability exists only for the callback's transaction lifetime.
        let active = true;
        const context = Object.freeze({userId, organizationId, role, query: (...args) => {
          if (!active) throw new Error('Authorization transaction has ended');
          return client.query(...args);
        }});
        let result;
        try { result = await work(context); } finally { active = false; }
        await client.query('COMMIT');
        begun = false;
        return result;
      } catch (error) {
        if (begun) {
          try { await client.query('ROLLBACK'); } catch (rollbackError) { discard = rollbackError; }
        }
        throw error;
      } finally {
        // pg pools destroy a connection passed an error; never reuse one with uncertain cleanup.
        client.release(discard);
      }
    }
  });
}

// Safe HTTP error mapping for future API handlers. Internal SQL/token details are never returned.
export function writeAuthError(response, error) {
  const known = error instanceof AuthError;
  response.writeHead(known ? error.status : 500, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    ...(known && error.status === 401 ? {'WWW-Authenticate': 'Bearer'} : {})
  });
  response.end(JSON.stringify({error: known ? error.code : 'internal_error'}));
}
