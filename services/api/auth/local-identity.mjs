import {randomBytes, createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {AuthError} from './errors.mjs';

const digest = token => createHash('sha256').update(token).digest('hex');
const loopback = address => address === '::1' || (isIP(address) === 4 && address.startsWith('127.')) || address === '::ffff:127.0.0.1';

// Server-side development helper. No public token issuance/login endpoint and no durable credentials.
export function createLocalIdentityProvider({mode, now = Date.now, ttlMs = 15 * 60_000} = {}) {
  if (!['development', 'test'].includes(mode) || (process.env.NODE_ENV === 'production')) {
    throw new Error('Local identity is restricted to explicit development/test mode');
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60 * 60_000) throw new Error('Invalid local session lifetime');
  const sessions = new Map();
  const prune = () => { for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key); };
  return Object.freeze({
    // Call only from a trusted local bootstrap/test, never from request-controlled identity fields.
    issue(subject) {
      if (typeof subject !== 'string' || !subject.trim() || subject.length > 200) throw new Error('Invalid synthetic subject');
      prune();
      const token = randomBytes(32).toString('base64url');
      sessions.set(digest(token), Object.freeze({issuer: 'urn:supply-vanguard:local', subject, expiresAt: now() + ttlMs}));
      return token;
    },
    revoke(token) { sessions.delete(digest(token)); },
    async verify(request) {
      if (!loopback(request.socket?.remoteAddress)) throw new AuthError(401, 'unauthenticated');
      const header = request.headers?.authorization;
      if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) throw new AuthError(401, 'unauthenticated');
      prune();
      const identity = sessions.get(digest(header.slice(7)));
      if (!identity) throw new AuthError(401, 'unauthenticated');
      return identity;
    }
  });
}
