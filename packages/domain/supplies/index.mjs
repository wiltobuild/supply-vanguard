export class SupplyError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new SupplyError(400, 'invalid_id');
  return value.toLowerCase();
}
export function text(value, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) throw new SupplyError(400, 'invalid_text');
  return value;
}
// Exact decimal quantities in the SKU's declared unit; no implicit pack/unit conversion.
export function quantity(value) {
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d{0,11})(\.\d{1,3})?$/.test(value)) throw new SupplyError(400, 'invalid_quantity');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const scaled = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  return `${negative && scaled ? '-' : ''}${scaled / 1000n}.${String(scaled % 1000n).padStart(3, '0')}`;
}
export function stockCommand(input) {
  const delta = quantity(input.delta);
  if (delta === '0.000' || !['adjustment', 'restock'].includes(input.kind) || (input.kind === 'restock' && delta.startsWith('-'))) throw new SupplyError(400, 'invalid_adjustment');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion >= 2147483647) throw new SupplyError(400, 'invalid_version');
  return {binId: uuid(input.binId), kind: input.kind, delta, expectedVersion: input.expectedVersion,
    idempotencyKey: text(input.idempotencyKey, 200), reason: text(input.reason, 500), source: text(input.source, 100),
    correlationId: input.correlationId == null ? null : text(input.correlationId, 200)};
}
