import {SupplyError, uuid, text, stockCommand} from '../../../packages/domain/supplies/index.mjs';
export {SupplyError} from '../../../packages/domain/supplies/index.mjs';

const replay = (row, command, actor) => {
  const same = row.bin_id === command.binId && row.kind === command.kind && row.delta === command.delta &&
    row.expected_version === command.expectedVersion && row.actor_id === actor && row.source === command.source &&
    row.reason === command.reason && row.correlation_id === command.correlationId;
  if (!same) throw new SupplyError(409, 'idempotency_conflict');
  return {...row, replayed: true};
};
const page = ({after, limit = 50} = {}) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SupplyError(400, 'invalid_page');
  return [after == null ? null : uuid(after), limit];
};
// Auth owns BEGIN/COMMIT/ROLLBACK and verified tenant/actor context. Never accept client role/user IDs.
export function createSupplies({authorization}) {
  if (typeof authorization?.run !== 'function') throw new Error('Authorization required');
  const run = async (request, organizationId, permission, work) => {
    try { return await authorization.run(request, {organizationId, permission}, work); }
    catch (error) {
      if (error.code === '40001' || error.code === '23505') throw new SupplyError(409, 'stock_conflict');
      if (['23503', '23514', '22003'].includes(error.code)) throw new SupplyError(400, 'invalid_stock');
      throw error;
    }
  };
  return Object.freeze({
    createSku(request, organizationId, input) {
      return run(request, organizationId, 'supplies:write', async c => {
        const unit = text(input.unit, 32);
        if (!/^[a-z][a-z0-9_-]{0,31}$/.test(unit)) throw new SupplyError(400, 'invalid_unit');
        return (await c.query('INSERT INTO public.supply_sku(organization_id, code, name, unit) VALUES ($1,$2,$3,$4) RETURNING *',
          [c.organizationId, text(input.code), text(input.name), unit])).rows[0];
      });
    },
    createBin(request, organizationId, input) {
      return run(request, organizationId, 'supplies:write', async c => (await c.query(
        'INSERT INTO public.supply_bin(organization_id, sku_id, location_id, code) VALUES ($1,$2,$3,$4) RETURNING *',
        [c.organizationId, uuid(input.skuId), uuid(input.locationId), text(input.code)])).rows[0]);
    },
    listSkus(request, organizationId, options) {
      return run(request, organizationId, 'inventory:read', async c => {
        const [after, limit] = page(options);
        return (await c.query('SELECT * FROM public.supply_sku WHERE organization_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3', [c.organizationId, after, limit])).rows;
      });
    },
    listBins(request, organizationId, options) {
      return run(request, organizationId, 'inventory:read', async c => {
        const [after, limit] = page(options);
        return (await c.query(`SELECT b.*, s.quantity, s.version, k.unit FROM public.supply_bin b
          JOIN public.supply_bin_stock s ON (s.organization_id,s.bin_id)=(b.organization_id,b.id)
          JOIN public.supply_sku k ON (k.organization_id,k.id)=(b.organization_id,b.sku_id)
          WHERE b.organization_id=$1 AND ($2::uuid IS NULL OR b.id>$2) ORDER BY b.id LIMIT $3`, [c.organizationId, after, limit])).rows;
      });
    },
    history(request, organizationId, binId, options) {
      return run(request, organizationId, 'audit:read', async c => {
        const [after, limit] = page(options);
        return (await c.query(`SELECT * FROM public.supply_stock_transaction WHERE organization_id=$1 AND bin_id=$2
          AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`, [c.organizationId, uuid(binId), after, limit])).rows;
      });
    },
    postStock(request, organizationId, input) {
      return run(request, organizationId, 'supplies:write', async c => {
        const command = stockCommand(input);
        const existing = async () => (await c.query('SELECT * FROM public.supply_stock_transaction WHERE organization_id=$1 AND idempotency_key=$2', [c.organizationId, command.idempotencyKey])).rows[0];
        const previous = await existing();
        if (previous) return replay(previous, command, c.userId);
        const stock = (await c.query('SELECT quantity, version FROM public.supply_bin_stock WHERE organization_id=$1 AND bin_id=$2', [c.organizationId, command.binId])).rows[0];
        if (!stock) throw new SupplyError(404, 'bin_not_found');
        if (stock.version !== command.expectedVersion) {
          // A matching request may have committed between the empty key lookup and this read.
          // At READ COMMITTED this new statement sees its ledger row before we reject the version.
          const committed = await existing();
          if (committed) return replay(committed, command, c.userId);
          throw new SupplyError(409, 'stock_conflict');
        }
        const inserted = await c.query(`INSERT INTO public.supply_stock_transaction
          (organization_id,bin_id,kind,delta,quantity_before,expected_version,actor_id,source,reason,correlation_id,idempotency_key)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (organization_id,idempotency_key) DO NOTHING RETURNING *`,
        [c.organizationId,command.binId,command.kind,command.delta,stock.quantity,command.expectedVersion,c.userId,command.source,command.reason,command.correlationId,command.idempotencyKey]);
        if (inserted.rows[0]) return {...inserted.rows[0], replayed: false};
        return replay(await existing(), command, c.userId);
      });
    }
  });
}
