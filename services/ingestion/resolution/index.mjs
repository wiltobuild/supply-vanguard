import {randomUUID} from 'node:crypto';
import {locationPolicy, resolveLocation, validateOverride, instant} from '../../../packages/domain/location/index.js';
import {boundedText, canonical, digest, uuid} from '../codec.mjs';

export class ResolutionError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const invalid = () => new ResolutionError(400, 'invalid-resolution-request');
const iso = value => new Date(value).toISOString();
const overrideRecord = row => row && ({id: row.id, organizationId: row.organization_id, equipmentId: row.equipment_id,
  locationId: row.location_id, observedAt: iso(row.observed_at), startsAt: iso(row.starts_at), expiresAt: iso(row.expires_at)});

// Current-state projection, intentionally separate from the mutable equipment API record.
// Never update core location/status/version/last_verified fields or read general equipment events.
export function createLocationResolution({authorization, policy: suppliedPolicy, now = Date.now, maxEvidence = 1000}) {
  if (typeof authorization?.run !== 'function' || !Number.isSafeInteger(maxEvidence) || maxEvidence < 1 || maxEvidence > 10_000) throw new Error('Authorization and bounded evidence limit required');
  const policy = locationPolicy(suppliedPolicy);
  async function safety(ctx) {
    const result = await ctx.query(`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('location_override', 'location_override_audit')
      AND c.relrowsecurity AND c.relforcerowsecurity AND NOT pg_has_role(current_user, c.relowner, 'USAGE')`);
    if (result.rows[0]?.count !== 2) throw new Error('Unsafe resolution tables or runtime role');
  }
  async function load(ctx, equipmentId, evaluatedAt) {
    // One SQL statement gives one MVCC snapshot, including the watermark, candidate window,
    // source receipts and latest override. No mixed-page or unbounded audit-history download.
    const result = await ctx.query(`WITH eligible AS (
        SELECT o.* FROM equipment_observation o WHERE o.organization_id = $1 AND o.equipment_id = $2
          AND o.observed_at <= $3::timestamptz AND o.received_at <= $3::timestamptz
      ), candidates AS (
        SELECT o.*, r.source_id FROM eligible o LEFT JOIN ingestion_receipt r
          ON r.organization_id = o.organization_id AND r.observation_id = o.id
        WHERE o.observed_at >= (SELECT max(observed_at) FROM eligible) - ($4::bigint * interval '1 millisecond')
        ORDER BY o.observed_at DESC, o.received_at DESC, o.id DESC LIMIT $5
      ) SELECT e.id,
        COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM candidates c), '[]'::jsonb) AS observations,
        (SELECT to_jsonb(v) FROM location_override v WHERE v.organization_id = $1 AND v.equipment_id = $2
          AND v.starts_at <= $3::timestamptz ORDER BY v.starts_at DESC, v.id DESC LIMIT 1) AS override
      FROM equipment e WHERE e.organization_id = $1 AND e.id = $2`,
    [ctx.organizationId, equipmentId, evaluatedAt, policy.conflictWindowMs, maxEvidence + 1]);
    const row = result.rows[0];
    if (!row) throw new ResolutionError(404, 'not-found');
    if (row.observations.length > maxEvidence) throw new ResolutionError(503, 'resolution-evidence-limit');
    const observations = row.observations.map(o => ({schemaVersion: 1, id: o.id, organizationId: o.organization_id,
      equipmentId: o.equipment_id, locationId: o.location_id, observedAt: iso(o.observed_at), receivedAt: iso(o.received_at),
      source: o.source, sourceId: o.source_id ?? null, actor: o.actor, idempotencyKey: o.idempotency_key,
      ...(o.correlation_id !== null && {correlationId: o.correlation_id})}));
    const override = overrideRecord(row.override);
    // Core composite FKs establish location/tenant existence for these persisted records.
    const locationIds = [...new Set([...observations.map(o => o.locationId), ...(override ? [override.locationId] : [])])];
    const input = {organizationId: ctx.organizationId, equipmentId, locationIds, observations, override, now: evaluatedAt, policy};
    return {input, projection: resolveLocation(input)};
  }
  return Object.freeze({
    async get({request, organizationId, equipmentId}) {
      if (!uuid(equipmentId)) throw invalid();
      return authorization.run(request, {organizationId, permission: 'inventory:read'}, async ctx => {
        await safety(ctx);
        return (await load(ctx, equipmentId, new Date(now()).toISOString())).projection;
      });
    },
    async override({request, organizationId, equipmentId, idempotencyKey, body}) {
      if (!uuid(equipmentId) || !boundedText(idempotencyKey, 100) || !body || Array.isArray(body)
        || Object.keys(body).some(k => !['locationId', 'observedAt', 'expiresAt', 'reason', 'correlationId'].includes(k))
        || !uuid(body.locationId) || !boundedText(body.reason, 500)
        || (body.correlationId !== undefined && !boundedText(body.correlationId, 100))) throw invalid();
      try { instant(body.observedAt); instant(body.expiresAt); } catch { throw invalid(); }
      // Snapshot caller input before authorization awaits. Identity comes only from ctx.
      const command = structuredClone(body), key = idempotencyKey;
      return authorization.run(request, {organizationId, permission: 'equipment:manage'}, async ctx => {
        await safety(ctx);
        const fingerprint = digest(canonical({equipmentId, userId: ctx.userId, command}));
        await ctx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 14014))', [`${ctx.organizationId}:key:${key}`]);
        const prior = (await ctx.query('SELECT fingerprint, after_state FROM location_override_audit WHERE organization_id = $1 AND idempotency_key = $2', [ctx.organizationId, key])).rows[0];
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new ResolutionError(409, 'idempotency-conflict');
          return {projection: prior.after_state, replayed: true};
        }
        await ctx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 14014))', [`${ctx.organizationId}:equipment:${equipmentId}`]);
        const evaluatedAt = new Date(now()).toISOString();
        const {input, projection: before} = await load(ctx, equipmentId, evaluatedAt);
        // No overlapping override or implicit replacement. Expiry is automatic and half-open.
        if (input.override && instant(input.override.expiresAt) > instant(evaluatedAt)) throw new ResolutionError(409, 'active-override');
        if (input.override && instant(command.observedAt) < instant(input.override.observedAt)) throw new ResolutionError(409, 'older-than-override');
        const location = await ctx.query('SELECT id FROM location WHERE organization_id = $1 AND id = $2', [ctx.organizationId, command.locationId]);
        if (!location.rows.length) throw new ResolutionError(404, 'not-found');
        const record = {id: randomUUID(), organizationId: ctx.organizationId, equipmentId,
          locationId: command.locationId, observedAt: command.observedAt, startsAt: evaluatedAt, expiresAt: command.expiresAt};
        const locationIds = [...new Set([...input.locationIds, record.locationId])];
        try { validateOverride(record, {...input, locationIds}, policy); } catch { throw invalid(); }
        const after = resolveLocation({...input, locationIds, override: record});
        await ctx.query(`INSERT INTO location_override(id, organization_id, equipment_id, location_id, observed_at, starts_at, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [record.id, ctx.organizationId, equipmentId, record.locationId, record.observedAt, record.startsAt, record.expiresAt]);
        await ctx.query(`INSERT INTO location_override_audit(override_id, organization_id, user_id, idempotency_key, fingerprint,
          recorded_at, reason, correlation_id, policy, before_state, after_state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb)`,
        [record.id, ctx.organizationId, ctx.userId, key, fingerprint, evaluatedAt, command.reason, command.correlationId ?? null,
          JSON.stringify(policy), JSON.stringify(before), JSON.stringify(after)]);
        return {projection: after, replayed: false};
      });
    }
  });
}
