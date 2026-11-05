import assert from 'node:assert/strict';
import {createSyntheticLocal} from './local-bootstrap.mjs';

const fixture = await createSyntheticLocal({mode: 'development'});
try {
  const {ingestion, signer, request, organizationId, equipmentId, locationId} = fixture;
  const equipmentBefore = (await fixture.owner.query('SELECT to_jsonb(equipment) AS state FROM equipment WHERE id = $1', [equipmentId])).rows[0].state;
  const observation = {schemaVersion: 1, equipmentId, locationId, observedAt: new Date(Date.now() - 60_000).toISOString(), source: 'simulator', idempotencyKey: 'synthetic-demo'};
  const envelope = signer.envelope(observation);
  const send = envelope => ingestion.ingest({request, organizationId, envelope});
  const accepted = await send(envelope);
  const replay = await send(envelope);
  const duplicate = await send(signer.envelope(observation));
  const malformed = await send(signer.envelope({...observation, idempotencyKey: 'malformed-demo', receivedAt: new Date().toISOString()}));
  assert.deepEqual([accepted.code, replay.code, duplicate.code, malformed.code], ['accepted', 'replay', 'duplicate', 'malformed']);
  const equipmentAfter = (await fixture.owner.query('SELECT to_jsonb(equipment) AS state FROM equipment WHERE id = $1', [equipmentId])).rows[0].state;
  assert.deepEqual(equipmentAfter, equipmentBefore);
  console.log(JSON.stringify({synthetic: true, accepted, replay, duplicate, malformed,
    storedObservations: (await fixture.owner.query('SELECT count(*)::int AS count FROM equipment_observation')).rows[0].count,
    deadLetters: (await fixture.owner.query('SELECT reason, received_at FROM ingestion_dead_letter ORDER BY received_at')).rows,
    equipmentLocationUnchanged: true}, null, 2));
} finally { await fixture.close(); }
