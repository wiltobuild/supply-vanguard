import {createHmac, randomBytes, timingSafeEqual, randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {canonical, uuid, boundedText} from './codec.mjs';

// Trusted local bootstrap only. Ephemeral keys never leave this closure or reach disk.
export function createLocalSourceVerifier({mode, now = Date.now, ttlMs = 15 * 60_000} = {}) {
  if (!['test', 'development'].includes(mode) || process.env.NODE_ENV === 'production') throw new Error('Local source verifier restricted to explicit development/test mode');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60 * 60_000) throw new Error('Invalid lifetime');
  const sources = new Map();
  return Object.freeze({
    provision({sourceId, organizationId, userId}) {
      if (!boundedText(sourceId, 64) || !uuid(organizationId) || !uuid(userId) || sources.has(sourceId)) throw new Error('Invalid synthetic source');
      const key = randomBytes(32), expiresAt = now() + ttlMs;
      const identity = Object.freeze({sourceId, organizationId, userId, source: 'simulator', actor: `simulator:${sourceId}`});
      const entry = {key, expiresAt, identity};
      sources.set(sourceId, entry);
      return Object.freeze({
        envelope(observation, {nonce = randomUUID(), sentAt = new Date(now()).toISOString()} = {}) {
          const message = {schemaVersion: 1, sourceId, nonce, sentAt, observation};
          return {...message, proof: createHmac('sha256', key).update(canonical(message)).digest('hex')};
        }
      });
    },
    revoke(sourceId) { sources.delete(sourceId); },
    async verify({request, envelope}) {
      const address = request.socket?.remoteAddress;
      if (!(address === '::1' || address === '::ffff:127.0.0.1' || (isIP(address ?? '') === 4 && address.startsWith('127.')))) return null;
      const entry = sources.get(envelope.sourceId);
      if (!entry || entry.expiresAt <= now() || typeof envelope.proof !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.proof)) return null;
      const {proof, ...message} = envelope;
      const expected = createHmac('sha256', entry.key).update(canonical(message)).digest();
      return timingSafeEqual(expected, Buffer.from(proof, 'hex')) ? entry.identity : null;
    }
  });
}
