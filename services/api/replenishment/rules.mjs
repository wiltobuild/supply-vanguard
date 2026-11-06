import {SupplyError, uuid, text, quantity} from '../../../packages/domain/supplies/index.mjs';
export {SupplyError};
export const fail = (status, code) => { throw new SupplyError(status, code); };
export function version(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2147483647) fail(400, 'invalid_version');
  return value;
}
export function nonnegative(value) {
  const normalized = quantity(value);
  if (normalized.startsWith('-')) fail(400, 'invalid_quantity');
  return normalized;
}
export function difference(a, b) {
  const scaled = v => BigInt(quantity(v).replace('.', ''));
  const delta = scaled(a) - scaled(b), abs = delta < 0n ? -delta : delta;
  return `${delta < 0n ? '-' : ''}${abs / 1000n}.${String(abs % 1000n).padStart(3, '0')}`;
}
export function normalize(operation, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'invalid_command');
  const c = {binId: uuid(input.binId), idempotencyKey: text(input.idempotencyKey),
    reason: text(input.reason, 500), source: text(input.source, 100),
    correlationId: input.correlationId == null ? null : text(input.correlationId)};
  if (operation === 'configure') Object.assign(c, {parQuantity: nonnegative(input.parQuantity), expectedPolicyVersion: version(input.expectedPolicyVersion)});
  if (['assign', 'complete'].includes(operation)) Object.assign(c, {taskId: uuid(input.taskId), expectedTaskVersion: version(input.expectedTaskVersion)});
  if (['complete', 'correct'].includes(operation)) c.expectedStockVersion = version(input.expectedStockVersion);
  if (operation === 'complete') c.receivedQuantity = nonnegative(input.receivedQuantity);
  if (operation === 'correct') c.countedQuantity = nonnegative(input.countedQuantity);
  return c;
}
export function pagination({after = null, limit = 50} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'invalid_page');
  return [after == null ? null : uuid(after), limit];
}
