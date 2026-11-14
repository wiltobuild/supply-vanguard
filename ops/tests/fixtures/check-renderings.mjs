// Public source-derived predicates. Their JSON-string SHA-256 fingerprints match the
// immutable isolated PostgreSQL 18.6 roundtrip receipt (2026-11-09), not a new native run.
export const checkRenderings = Object.freeze({
  original: `CHECK ((((length(idempotency_key) >= 7) AND (length(idempotency_key) <= 106)) AND ("left"(idempotency_key, 6) = 'admin:'::text)))`,
  reparsed: `CHECK (((length(idempotency_key) >= 7) AND (length(idempotency_key) <= 106) AND ("left"(idempotency_key, 6) = 'admin:'::text)))`,
  pretty: `CHECK (length(idempotency_key) >= 7 AND length(idempotency_key) <= 106 AND "left"(idempotency_key, 6) = 'admin:'::text)`,
  precedenceAnd: `CHECK (length(idempotency_key) >= 7 AND (length(idempotency_key) <= 106 OR "left"(idempotency_key, 6) = 'admin:'::text))`,
  precedenceOr: `CHECK (length(idempotency_key) >= 7 AND length(idempotency_key) <= 106 OR "left"(idempotency_key, 6) = 'admin:'::text)`,
});
