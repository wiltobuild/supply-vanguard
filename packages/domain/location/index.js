import {validateObservation} from '../contracts.js';

const fail = message => { throw new Error(message); };
const text = (value, name) => typeof value === 'string' && value.trim() && value.length <= 100 ? value : fail(`Invalid ${name}`);
export const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? Date.parse(value) : fail('Invalid UTC instant');

// No operational defaults. The host must supply an approved, versioned policy.
export function locationPolicy(input) {
  if (!input || Object.keys(input).sort().join(',') !== 'conflictWindowMs,freshMs,maxOverrideMs,staleMs,version') fail('Explicit location policy required');
  text(input.version, 'policy version');
  for (const key of ['freshMs', 'staleMs', 'conflictWindowMs', 'maxOverrideMs']) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) fail(`Invalid ${key}`);
  }
  if (input.staleMs < input.freshMs || input.maxOverrideMs < 1) fail('Invalid policy bounds');
  return Object.freeze({...input});
}

const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// UUID/receipt order is reproducibility only, never source authority.
export const compareEvidence = (a, b) => instant(a.observedAt) - instant(b.observedAt)
  || instant(a.receivedAt) - instant(b.receivedAt) || lexical(a.id, b.id);

export function validateEvidence(record, {organizationId, equipmentId, locationIds}) {
  if (record.organizationId !== organizationId || record.equipmentId !== equipmentId) fail('Evidence scope mismatch');
  text(record.id, 'evidence ID');
  if (record.sourceId !== null) text(record.sourceId, 'source ID');
  const {id, organizationId: tenant, sourceId, ...observation} = record;
  validateObservation(observation, locationIds);
  if (instant(record.observedAt) > instant(record.receivedAt)) fail('Observation after receipt');
  return record;
}

export function validateOverride(record, scope, policy) {
  if (record.organizationId !== scope.organizationId || record.equipmentId !== scope.equipmentId) fail('Override scope mismatch');
  text(record.id, 'override ID');
  if (!scope.locationIds.includes(record.locationId)) fail('Unknown override location');
  const start = instant(record.startsAt), end = instant(record.expiresAt), observed = instant(record.observedAt);
  if (observed > start || end <= start || end - start > policy.maxOverrideMs) fail('Invalid override bounds');
  return record;
}

export function resolveLocation({organizationId, equipmentId, locationIds, observations, override = null, now, policy: input}) {
  const policy = locationPolicy(input), at = instant(now), scope = {organizationId, equipmentId, locationIds};
  text(organizationId, 'organization ID'); text(equipmentId, 'equipment ID');
  // Detach and validate every record; fail closed on corrupt/cross-tenant/changed duplicate evidence.
  const ids = new Map(), keys = new Map();
  for (const candidate of observations) {
    const record = validateEvidence(candidate, scope), encoded = JSON.stringify(Object.fromEntries(Object.entries(record).sort()));
    if ((ids.has(record.id) && ids.get(record.id).encoded !== encoded)
      || (keys.has(record.idempotencyKey) && keys.get(record.idempotencyKey) !== record.id)) fail('Conflicting duplicate evidence');
    ids.set(record.id, {record: structuredClone(record), encoded}); keys.set(record.idempotencyKey, record.id);
  }
  const eligible = [...ids.values()].map(v => v.record).filter(o => instant(o.receivedAt) <= at && instant(o.observedAt) <= at).sort(compareEvidence);
  const latest = eligible.at(-1) ?? null;
  const candidates = latest ? eligible.filter(o => instant(latest.observedAt) - instant(o.observedAt) <= policy.conflictWindowMs) : [];
  const locations = [...new Set(candidates.map(o => o.locationId))].sort(lexical);
  const age = observed => at - instant(observed);
  const freshness = observed => age(observed) <= policy.freshMs ? 'fresh' : age(observed) <= policy.staleMs ? 'aging' : 'stale';
  const base = {schemaVersion: 1, organizationId, equipmentId, evaluatedAt: now, policyVersion: policy.version,
    locationId: null, state: 'unknown', freshness: 'unknown', observedAt: null, receivedAt: null,
    evidence: candidates, conflictingLocationIds: locations.length > 1 ? locations : [], override: null};
  if (override) {
    // Validate against its recorded policy at the service boundary before passing here. A later
    // policy may shorten new overrides, but must not rewrite already-audited bounds.
    validateOverride(override, scope, {...policy, maxOverrideMs: Number.MAX_SAFE_INTEGER});
    if (instant(override.startsAt) <= at && at < instant(override.expiresAt)) {
      const f = freshness(override.observedAt);
      return {...base, locationId: override.locationId, state: f, freshness: f, reason: 'manual-override',
        observedAt: override.observedAt, receivedAt: override.startsAt, override: structuredClone(override)};
    }
    // Expiry never resurrects a sensor location older than the manual attestation.
    if (instant(override.expiresAt) <= at && (!latest || instant(latest.observedAt) <= instant(override.observedAt))) {
      return {...base, reason: 'expired-override', override: structuredClone(override)};
    }
  }
  if (!latest) return {...base, reason: 'no-observation'};
  const f = freshness(latest.observedAt);
  return {...base, locationId: locations.length === 1 ? latest.locationId : null,
    state: locations.length > 1 ? 'uncertain' : f, freshness: f,
    reason: locations.length > 1 ? 'conflicting-observations' : 'observed', observedAt: latest.observedAt, receivedAt: latest.receivedAt};
}
