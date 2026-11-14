import {ApiError, recordObservation} from '../equipment/service.mjs';

const invalid = detail => new ApiError(400, 'invalid_request', detail);
const identifier = (v, name, max = 64) => {
 if (typeof v !== 'string' || v.length > max || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) throw invalid(`${name} must be a bounded identifier`);
 return v;
};
export function normalizeCheckIn(body, idempotencyKey, correlationId) {
 if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['equipmentId','locationId','observedAt','source'].includes(k))) throw invalid('Unsupported check-in fields');
 identifier(idempotencyKey, 'Idempotency-Key', 80);
 const equipmentId = identifier(body.equipmentId, 'equipmentId');
 const locationId = identifier(body.locationId, 'locationId');
 if (!['manual-check-in','barcode','qr'].includes(body.source)) throw invalid('source must describe manual entry, barcode or QR');
 if (typeof body.observedAt !== 'string' || body.observedAt.length > 30 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(body.observedAt) || !Number.isFinite(Date.parse(body.observedAt))) throw invalid('observedAt must be a UTC ISO timestamp');
 const observedAt = new Date(body.observedAt).toISOString();
 // Reject normalized invalid dates such as February 30.
 if (observedAt.slice(0,19) !== body.observedAt.slice(0,19)) throw invalid('observedAt is not a calendar instant');
 if (correlationId !== undefined) identifier(correlationId, 'X-Correlation-Id', 100);
 return {equipmentId, locationId, observedAt, source:body.source, correlationId:correlationId ?? null};
}

// Must run inside createAuthorization.run(...equipment:write...). A receipt reservation serializes
// identical keys across equipment and actors. Its snapshot, observation, event and state commit together.
export async function checkIn(ctx, body, {idempotencyKey, correlationId} = {}) {
 const request = normalizeCheckIn(body, idempotencyKey, correlationId);
 await ctx.query(`INSERT INTO public.check_in_receipt (organization_id,idempotency_key,user_id,request)
  VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (organization_id,idempotency_key) DO NOTHING`,
 [ctx.organizationId,idempotencyKey,ctx.userId,JSON.stringify(request)]);
 const prior = (await ctx.query(`SELECT request,result FROM public.check_in_receipt
  WHERE organization_id=$1 AND idempotency_key=$2 AND user_id=$3`,[ctx.organizationId,idempotencyKey,ctx.userId])).rows[0];
 if (!prior || Object.keys(request).some(k => prior.request[k] !== request[k])) throw new ApiError(409,'idempotency_key_reused');
 if (prior.result) return {...prior.result,replayed:true};

 // Lock only equipment before the existing service performs its fresh joined read. This avoids
 // depending on the pending SV-023 joined-lock repair and does not modify that shared service.
 const locked = await ctx.query('SELECT id FROM equipment WHERE organization_id=$1 AND external_id=$2 FOR UPDATE',[ctx.organizationId,request.equipmentId]);
 if (!locked.rows.length) throw new ApiError(404,'not_found');
 const result = await recordObservation(ctx, request.equipmentId,
  {locationId:request.locationId,observedAt:request.observedAt,source:request.source},
  {idempotencyKey:`check-in:${idempotencyKey}`,...(correlationId && {correlationId})});
 // A colliding pre-existing observation key must never become another actor's success.
 if (result.reason === 'duplicate-idempotency-key') throw new ApiError(409,'idempotency_key_reused');
 const observation = (await ctx.query(`SELECT observed_at,received_at,actor,source FROM equipment_observation
  WHERE organization_id=$1 AND idempotency_key=$2`,[ctx.organizationId,`check-in:${idempotencyKey}`])).rows[0];
 if (!observation || observation.actor !== `user:${ctx.userId}`) throw new Error('Missing attributed observation');
 const output = {...result,replayed:false,observation:{equipmentId:request.equipmentId,locationId:request.locationId,
  observedAt:new Date(observation.observed_at).toISOString(),receivedAt:new Date(observation.received_at).toISOString(),
  actor:observation.actor,source:observation.source}};
 await ctx.query(`UPDATE public.check_in_receipt SET result=$3::jsonb WHERE organization_id=$1 AND idempotency_key=$2`,[ctx.organizationId,idempotencyKey,JSON.stringify(output)]);
 return output;
}

export async function listCheckInLocations(ctx) {
 return {items:(await ctx.query('SELECT external_key AS id,name,kind FROM location WHERE organization_id=$1 ORDER BY name,external_key',[ctx.organizationId])).rows};
}
