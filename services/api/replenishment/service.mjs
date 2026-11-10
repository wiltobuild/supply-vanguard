import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {permits} from '../auth/roles.mjs';
import {uuid} from '../../../packages/domain/supplies/index.mjs';
import {fail, normalize, difference, pagination} from './rules.mjs';

const json = value => JSON.parse(JSON.stringify(value));
const BIN = `SELECT b.id,b.code,b.location_id,k.name,k.unit,s.quantity,s.version AS stock_version,
  p.quantity AS par_quantity,coalesce(p.version,0) AS par_version,
  CASE WHEN p.quantity IS NULL THEN NULL ELSE s.quantity < p.quantity END AS low_par
  FROM public.supply_bin b
  JOIN public.supply_sku k ON (k.organization_id,k.id)=(b.organization_id,b.sku_id)
  JOIN public.supply_bin_stock s ON (s.organization_id,s.bin_id)=(b.organization_id,b.id)
  LEFT JOIN LATERAL (SELECT quantity,version FROM public.replenishment_par
    WHERE organization_id=b.organization_id AND bin_id=b.id ORDER BY version DESC LIMIT 1) p ON true
  WHERE b.organization_id=$1`;

// Only the existing verified authorization capability owns transactions/identity/tenant context.
export function createReplenishment({authorization}) {
  if (typeof authorization?.run !== 'function') throw Error('Authorization required');
  const run = async (request, organizationId, permission, work) => {
    try { return await authorization.run(request, {organizationId, permission}, work); }
    catch (error) {
      if (['40001','23505','40P01'].includes(error.code)) fail(409, 'replenishment_conflict');
      if (['23503','23514','22003'].includes(error.code)) fail(400, 'invalid_replenishment');
      throw error;
    }
  };
  const bin = async (c, id) => (await c.query(`${BIN} AND b.id=$2`, [c.organizationId, id])).rows[0] || fail(404, 'bin_not_found');
  const event = async (c, command, kind, detail, taskId = null) => (await c.query(`INSERT INTO public.replenishment_event
    (organization_id,bin_id,task_id,kind,actor_id,detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
    [c.organizationId, command.binId, taskId, kind, c.userId, JSON.stringify({...detail,
      reason: command.reason, source: command.source, correlationId: command.correlationId})])).rows[0];
  const stock = async (c, command, current, delta, kind) => {
    if (current.stock_version !== command.expectedStockVersion) fail(409, 'stock_conflict');
    if (delta === '0.000') return null;
    // Write directly in the SAME auth transaction; calling supplies.postStock would open a second one.
    // The existing ledger trigger/version constraints apply deltas atomically and reject concurrent ledger edits.
    return (await c.query(`INSERT INTO public.supply_stock_transaction
      (organization_id,bin_id,kind,delta,quantity_before,expected_version,actor_id,source,reason,correlation_id,idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [c.organizationId,command.binId,kind,delta,current.quantity,command.expectedStockVersion,c.userId,
        command.source,command.reason,command.correlationId,`sv010:${randomUUID()}`])).rows[0];
  };
  const mutate = (operation, request, organizationId, input, work) => run(request, organizationId, 'supplies:write', async c => {
    const command = normalize(operation, input), savedCommand = {operation, ...command};
    // Stable order: key lock then bin lock. Advisory collisions only serialize extra work.
    // READ COMMITTED statements after waiting see the winner's immutable receipt.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sv010:key:${c.organizationId}:${command.idempotencyKey}`]);
    const previous = (await c.query('SELECT * FROM public.replenishment_receipt WHERE organization_id=$1 AND idempotency_key=$2',
      [c.organizationId,command.idempotencyKey])).rows[0];
    if (previous) {
      if (previous.actor_id !== c.userId || !isDeepStrictEqual(previous.command, savedCommand)) fail(409, 'idempotency_conflict');
      return {...previous.result, replayed: true};
    }
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sv010:bin:${c.organizationId}:${command.binId}`]);
    const current = await bin(c, command.binId);
    const result = json(await work(c, command, current));
    await c.query(`INSERT INTO public.replenishment_receipt(organization_id,idempotency_key,actor_id,command,result)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`, [c.organizationId,command.idempotencyKey,c.userId,JSON.stringify(savedCommand),JSON.stringify(result)]);
    return {...result, replayed: false};
  });
  const task = async (c, command) => {
    const row = (await c.query('SELECT * FROM public.replenishment_task WHERE organization_id=$1 AND bin_id=$2 AND id=$3 FOR UPDATE',
      [c.organizationId,command.binId,command.taskId])).rows[0];
    if (!row) fail(404, 'task_not_found');
    if (row.version !== command.expectedTaskVersion) fail(409, 'task_conflict');
    return row;
  };
  return Object.freeze({
    listBins(request, organizationId, options) {
      return run(request, organizationId, 'inventory:read', async c => {
        const [after, limit] = pagination(options);
        const rows = (await c.query(`${BIN} AND ($2::uuid IS NULL OR b.id>$2) ORDER BY b.id LIMIT $3`, [c.organizationId,after,limit+1])).rows;
        return {items: rows.slice(0,limit), nextCursor: rows.length > limit ? rows[limit-1].id : null, canWrite: permits(c.role,'supplies:write')};
      });
    },
    listTasks(request, organizationId, options) {
      return run(request, organizationId, 'inventory:read', async c => {
        const [after, limit] = pagination(options);
        const rows = (await c.query(`SELECT t.*,k.name,k.unit,b.code,s.quantity,s.version AS stock_version,p.quantity AS par_quantity,
          s.quantity<p.quantity AS low_par,(t.assignee_id=$4) AS assigned_to_me
          FROM public.replenishment_task t
          JOIN public.supply_bin b ON (b.organization_id,b.id)=(t.organization_id,t.bin_id)
          JOIN public.supply_sku k ON (k.organization_id,k.id)=(b.organization_id,b.sku_id)
          JOIN public.supply_bin_stock s ON (s.organization_id,s.bin_id)=(t.organization_id,t.bin_id)
          JOIN LATERAL (SELECT quantity FROM public.replenishment_par WHERE organization_id=t.organization_id AND bin_id=t.bin_id ORDER BY version DESC LIMIT 1) p ON true
          WHERE t.organization_id=$1 AND t.status<>'completed' AND ($2::uuid IS NULL OR t.id>$2) ORDER BY t.id LIMIT $3`,
          [c.organizationId,after,limit+1,c.userId])).rows;
        return {items: rows.slice(0,limit), nextCursor: rows.length > limit ? rows[limit-1].id : null};
      });
    },
    history(request, organizationId, binId, options) {
      return run(request, organizationId, 'audit:read', async c => {
        const [after, limit] = pagination(options);
        await bin(c, uuid(binId));
        const rows = (await c.query(`SELECT * FROM public.replenishment_event WHERE organization_id=$1 AND bin_id=$2
          AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`, [c.organizationId,binId,after,limit+1])).rows;
        return {items: rows.slice(0,limit), nextCursor: rows.length > limit ? rows[limit-1].id : null};
      });
    },
    configure(request, organizationId, input) {
      return mutate('configure',request,organizationId,input,async (c,q,b) => {
        if (b.par_version !== q.expectedPolicyVersion) fail(409, 'policy_conflict');
        const policy = (await c.query(`INSERT INTO public.replenishment_par(organization_id,bin_id,version,quantity,actor_id,reason)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [c.organizationId,q.binId,b.par_version+1,q.parQuantity,c.userId,q.reason])).rows[0];
        return {policy, event: await event(c,q,'par-configured',{before: b.par_quantity, after: q.parQuantity, policyVersion: policy.version, unit: b.unit})};
      });
    },
    detect(request, organizationId, input) {
      return mutate('detect',request,organizationId,input,async (c,q,b) => {
        const active = (await c.query("SELECT * FROM public.replenishment_task WHERE organization_id=$1 AND bin_id=$2 AND status<>'completed'",[c.organizationId,q.binId])).rows[0];
        if (active) return {task: active, created: false, lowPar: b.low_par};
        if (b.low_par !== true) return {task: null, created: false, lowPar: b.low_par};
        const created = (await c.query(`INSERT INTO public.replenishment_task(organization_id,bin_id,par_version,detected_quantity)
          VALUES ($1,$2,$3,$4) RETURNING *`,[c.organizationId,q.binId,b.par_version,b.quantity])).rows[0];
        return {task: created, created: true, lowPar: true,
          event: await event(c,q,'low-par-detected',{quantity: b.quantity, parQuantity: b.par_quantity, unit: b.unit},created.id)};
      });
    },
    assign(request, organizationId, input) {
      return mutate('assign',request,organizationId,input,async (c,q) => {
        const before = await task(c,q);
        if (before.status !== 'open') fail(409, 'task_conflict');
        const assigned = (await c.query(`UPDATE public.replenishment_task SET status='assigned',assignee_id=$3,version=version+1
          WHERE organization_id=$1 AND id=$2 RETURNING *`,[c.organizationId,q.taskId,c.userId])).rows[0];
        return {task: assigned, event: await event(c,q,'assigned',{before, after: assigned},q.taskId)};
      });
    },
    complete(request, organizationId, input) {
      return mutate('complete',request,organizationId,input,async (c,q,b) => {
        const before = await task(c,q);
        if (before.status !== 'assigned' || before.assignee_id !== c.userId) fail(409, 'task_conflict');
        const transaction = await stock(c,q,b,q.receivedQuantity,'restock');
        const completed = (await c.query(`UPDATE public.replenishment_task SET status='completed',completed_at=clock_timestamp(),version=version+1
          WHERE organization_id=$1 AND id=$2 RETURNING *`,[c.organizationId,q.taskId])).rows[0];
        return {task: completed, transaction, event: await event(c,q,'completed',{
          before, after: completed, receivedQuantity: q.receivedQuantity, quantityBefore: b.quantity,
          quantityAfter: transaction?.quantity_after ?? b.quantity, unit: b.unit, transactionId: transaction?.id ?? null},q.taskId)};
      });
    },
    correct(request, organizationId, input) {
      return mutate('correct',request,organizationId,input,async (c,q,b) => {
        const delta = difference(q.countedQuantity,b.quantity);
        const transaction = await stock(c,q,b,delta,'adjustment');
        return {transaction, event: await event(c,q,'count-corrected',{
          quantityBefore: b.quantity, countedQuantity: q.countedQuantity, delta, unit: b.unit,
          stockVersion: transaction?.version_after ?? b.stock_version, transactionId: transaction?.id ?? null})};
      });
    }
  });
}
