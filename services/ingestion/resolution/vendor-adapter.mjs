import {OBSERVATION_SOURCES} from '../../../packages/domain/contracts.js';
import {instant} from '../../../packages/domain/location/index.js';
import {boundedText, canonical, digest, uuid} from '../codec.mjs';

// Trusted server configuration supplies decoding and tenant-bound ID mapping. This adapter
// normalizes evidence only; createIngestion still authenticates the entire signed envelope.
export function createVendorAdapter({sourceId, source, organizationId, decode, equipmentIdForTag, locationIdForZone}) {
  if (!boundedText(sourceId, 64) || !uuid(organizationId) || !OBSERVATION_SOURCES.includes(source)
    || !['rfid', 'ble', 'rtls', 'simulator'].includes(source)
    || [decode, equipmentIdForTag, locationIdForZone].some(fn => typeof fn !== 'function')) throw new Error('Trusted adapter bindings required');
  return Object.freeze({
    async normalize(payload) {
      // decode authenticates vendor-specific payloads where applicable. No payload field can
      // replace configured tenant/source bindings or provide authoritative coordinates.
      const reading = structuredClone(await decode(payload));
      if (!reading || typeof reading !== 'object' || Array.isArray(reading)
        || Object.keys(reading).some(k => !['readingId', 'tagId', 'zoneId', 'observedAt', 'correlationId'].includes(k))
        || !['readingId', 'tagId', 'zoneId'].every(k => boundedText(reading[k], 100))
        || (reading.correlationId !== undefined && !boundedText(reading.correlationId, 100))) throw new Error('Invalid normalized reading');
      instant(reading.observedAt);
      const equipmentId = await equipmentIdForTag({organizationId, tagId: reading.tagId});
      const locationId = await locationIdForZone({organizationId, zoneId: reading.zoneId});
      if (!uuid(equipmentId) || !uuid(locationId)) throw new Error('Unknown vendor mapping');
      return {organizationId, sourceId, observation: {schemaVersion: 1, equipmentId, locationId,
        observedAt: reading.observedAt, source,
        idempotencyKey: `vendor:${digest(canonical({sourceId, readingId: reading.readingId}))}`,
        ...(reading.correlationId !== undefined && {correlationId: reading.correlationId})}};
    }
  });
}
