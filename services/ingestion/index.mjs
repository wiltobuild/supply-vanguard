import {randomUUID} from 'node:crypto';
import {validateObservation, OBSERVATION_SOURCES} from '../../packages/domain/contracts.js';
import {AuthError} from '../api/auth/index.mjs';
import {canonical, digest, uuid, boundedText, utc} from './codec.mjs';

const rejected = (status, code) => ({status, code});
const shape = envelope => envelope && typeof envelope === 'object' && !Array.isArray(envelope)
  && Object.keys(envelope).every(k => ['schemaVersion', 'sourceId', 'nonce', 'sentAt', 'observation', 'proof'].includes(k))
  && envelope.schemaVersion === 1 && boundedText(envelope.sourceId, 64) && boundedText(envelope.nonce, 100)
  && utc(envelope.sentAt) && envelope.observation && typeof envelope.observation === 'object' && !Array.isArray(envelope.observation);

// verification must authenticate the ENTIRE immutable envelope and return trusted source/tenant/
// membership bindings. Never derive these bindings from a decoded but unverified request body.
export function createIngestion({authorization, verification, rejectionJournal, now = Date.now, replayWindowMs = 5 * 60_000}) {
  if (typeof authorization?.run !== 'function' || typeof verification?.verify !== 'function' || typeof rejectionJournal !== 'function') throw new Error('Authorization, source verifier and durable rejection journal required');
  if (!Number.isSafeInteger(replayWindowMs) || replayWindowMs < 1) throw new Error('Invalid replay window');
  async function rejectExternal(reason, bytes, status = 400) {
    await rejectionJournal({reason, receivedAt: new Date(now()).toISOString(), envelopeDigest: digest(bytes)});
    return rejected(status, reason);
  }
  return Object.freeze({
    rejectExternal,
    async ingest({request, organizationId, envelope}) {
      // Serialize once, cap direct callers too, and detach from mutable caller objects before await.
      let bytes;
      try { bytes = JSON.stringify(envelope); } catch { return rejectExternal('malformed', 'non-json'); }
      if (typeof bytes !== 'string') return rejectExternal('malformed', 'non-json');
      if (Buffer.byteLength(bytes) > 16_384) return rejectExternal('payload-too-large', bytes, 413);
      const message = JSON.parse(bytes), envelopeDigest = digest(bytes), receivedAt = new Date(now()).toISOString();
      try {
        return await authorization.run(request, {organizationId, permission: 'equipment:write'}, async context => {
          const safety = await context.query(`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname IN ('ingestion_nonce', 'ingestion_receipt', 'ingestion_dead_letter')
            AND c.relrowsecurity AND c.relforcerowsecurity AND NOT pg_has_role(current_user, c.relowner, 'USAGE')`);
          if (safety.rows[0]?.count !== 3) throw new Error('Unsafe ingestion tables or runtime role');
          const reject = async (reason, status = 400) => {
            await context.query('INSERT INTO ingestion_dead_letter(organization_id, user_id, received_at, reason, envelope_digest) VALUES ($1, $2, $3, $4, $5)', [context.organizationId, context.userId, receivedAt, reason, envelopeDigest]);
            return rejected(status, reason);
          };
          if (!shape(message)) return reject('malformed');
          const identity = await verification.verify({request, envelope: message});
          if (!identity || identity.organizationId !== context.organizationId || identity.userId !== context.userId
              || identity.sourceId !== message.sourceId || !OBSERVATION_SOURCES.includes(identity.source) || !boundedText(identity.actor, 100)) return reject('unauthorized-source', 403);
          // Transmission must be fresh; physical observation time may be old/offline.
          const sent = Date.parse(message.sentAt), received = Date.parse(receivedAt);
          if (sent > received || received - sent > replayWindowMs) return reject('replay-window', 409);
          const nonce = await context.query('INSERT INTO ingestion_nonce(organization_id, source_id, nonce, received_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING nonce', [organizationId, identity.sourceId, message.nonce, receivedAt]);
          if (!nonce.rows.length) return reject('replay', 409);
          const input = message.observation;
          // actor/receivedAt belong to the server; source must match verified provenance.
          if (Object.hasOwn(input, 'actor') || Object.hasOwn(input, 'receivedAt') || input.source !== identity.source || !uuid(input.equipmentId) || !uuid(input.locationId) || !utc(input.observedAt)) return reject('malformed');
          const observation = {...input, receivedAt, actor: identity.actor};
          try {
            validateObservation(observation, [input.locationId]);
            if (Date.parse(observation.observedAt) > received) return reject('malformed');
          } catch { return reject('malformed'); }
          const fingerprint = digest(canonical({observation: input, sourceId: identity.sourceId, userId: context.userId, actor: identity.actor}));
          // Transaction-scoped lock handles both concurrent identical deliveries and conflicting keys.
          // No JS mutex: distinct pool connections contend on PostgreSQL's actual transaction lock.
          await context.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 13013))', [`${organizationId}:${observation.idempotencyKey}`]);
          const prior = (await context.query('SELECT observation_id, fingerprint, received_at FROM ingestion_receipt WHERE organization_id = $1 AND idempotency_key = $2', [organizationId, observation.idempotencyKey])).rows[0];
          if (prior) return prior.fingerprint === fingerprint
            ? {status: 200, code: 'duplicate', observationId: prior.observation_id, receivedAt: new Date(prior.received_at).toISOString()}
            : reject('idempotency-conflict', 409);
          const references = await context.query('SELECT EXISTS(SELECT 1 FROM equipment WHERE organization_id = $1 AND id = $2) AND EXISTS(SELECT 1 FROM location WHERE organization_id = $1 AND id = $3) AS valid', [organizationId, observation.equipmentId, observation.locationId]);
          if (!references.rows[0]?.valid) return reject('unknown-reference', 404);
          const observationId = randomUUID();
          const inserted = await context.query(`INSERT INTO equipment_observation(id, organization_id, equipment_id, location_id, observed_at, received_at, source, actor, correlation_id, idempotency_key)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (organization_id, idempotency_key) DO NOTHING RETURNING id`,
          [observationId, organizationId, observation.equipmentId, observation.locationId, observation.observedAt, receivedAt, observation.source, observation.actor, observation.correlationId ?? null, observation.idempotencyKey]);
          // A key used by another producer is never adopted as this source's successful receipt.
          if (!inserted.rows.length) return reject('idempotency-conflict', 409);
          await context.query('INSERT INTO ingestion_receipt(organization_id, idempotency_key, observation_id, source_id, user_id, fingerprint, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [organizationId, observation.idempotencyKey, observationId, identity.sourceId, context.userId, fingerprint, receivedAt]);
          return {status: 201, code: 'accepted', observationId, observedAt: observation.observedAt, receivedAt};
        });
      } catch (error) {
        // Authorization failures cannot be attributed to a caller-claimed tenant. A separate
        // operator journal retains a safe digest even when the transaction is rolled back.
        const known = error instanceof AuthError;
        await rejectionJournal({receivedAt, envelopeDigest, reason: known ? error.code : 'ingestion-failure'});
        if (known) return rejected(error.status, error.code);
        throw error;
      }
    }
  });
}
