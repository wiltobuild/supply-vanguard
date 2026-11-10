import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixture.mjs';
import {difference,normalize} from '../rules.mjs';
import {createReplenishmentClient} from '../../../../apps/web/supplies/client.mjs';
let f;
before(async()=>{f=await fixture();});
after(async()=>{await f?.close();});
const invoke=(method,q,who='manager',org=f.A)=>f.service[method](f.request(who),org,q);
async function activeBin() {
  const b=await f.newBin();
  await invoke('configure',f.command(b,{parQuantity:'5.125',expectedPolicyVersion:0}));
  const {task}=await invoke('detect',f.command(b));
  return {b,task};
}
const balance=async b=>(await f.owner('SELECT quantity,version FROM supply_bin_stock WHERE bin_id=$1',[b.id])).rows[0];

test('exact decimal string quantities, no implicit conversions and bounded inputs',()=>{
  assert.equal(difference('999999999999.999','0.001'),'999999999999.998');
  assert.equal(difference('0','0.125'),'-0.125');
  const q={binId:randomUUID(),idempotencyKey:'test',reason:'Synthetic',source:'test',expectedStockVersion:0};
  for(const receivedQuantity of [-1,1,'-1','0.0001','1e3','1000000000000','NaN'])
    assert.throws(()=>normalize('complete',{...q,taskId:randomUUID(),expectedTaskVersion:0,receivedQuantity}),{status:400});
  assert.throws(()=>normalize('correct',{...q,countedQuantity:'1',expectedStockVersion:-1}),{code:'invalid_version'});
});
test('unconfigured bins stay undecided; strict below-par comparison uses explicit unit and threshold',async()=>{
  const b=await f.newBin();
  assert.equal((await invoke('detect',f.command(b))).lowPar,null);
  assert.equal((await f.service.listTasks(f.manager,f.A)).items.length,0);
  await f.stock(b,{delta:'5.125'});
  const configured=await invoke('configure',f.command(b,{parQuantity:'5.125',expectedPolicyVersion:0}));
  assert.equal(configured.policy.quantity,'5.125');
  assert.equal((await invoke('detect',f.command(b))).task,null,'equal to par is not low');
  await f.stock(b,{kind:'adjustment',delta:'-0.001',expectedVersion:1});
  const detection=await invoke('detect',f.command(b));
  assert.equal(detection.task.detected_quantity,'5.124');
  const item=(await f.service.listBins(f.manager,f.A)).items.find(row=>row.id===b.id);
  assert.equal(item.unit,'ml');assert.equal(item.low_par,true);
});
test('repeated detection deduplicates active in-app alerts; immutable replay returns original snapshot',async()=>{
  const {b,task}=await activeBin(),q=f.command(b);
  const first=await invoke('detect',q);
  const checks=await Promise.all(Array.from({length:16},()=>invoke('detect',f.command(b))));
  assert.equal(new Set(checks.map(x=>x.task.id)).size,1);assert.equal(checks[0].task.id,task.id);
  await invoke('assign',f.command(b,{taskId:task.id,expectedTaskVersion:0}));
  const replay=await invoke('detect',q);
  assert.deepEqual(replay,{...first,replayed:true});assert.equal(replay.task.status,'open');
  assert.equal((await f.owner("SELECT count(*)::int AS n FROM replenishment_event WHERE bin_id=$1 AND kind='low-par-detected'",[b.id])).rows[0].n,1);
  await assert.rejects(invoke('detect',{...q,reason:'Changed'}),{code:'idempotency_conflict'});
  await assert.rejects(invoke('detect',q,'other'),{code:'idempotency_conflict'});
});
test('serialized assignment/completion competitors have one winner; retries cannot double-add stock',async()=>{
  const {b,task}=await activeBin();
  const claims=await Promise.allSettled(['manager','other'].map(who=>invoke('assign',f.command(b,{taskId:task.id,expectedTaskVersion:0}),who)));
  assert.equal(claims.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(claims.find(x=>x.status==='rejected').reason.status,409);
  const assigned=claims.find(x=>x.status==='fulfilled').value.task;
  const who=assigned.assignee_id===f.users.manager?'manager':'other';
  const q=f.command(b,{taskId:task.id,expectedTaskVersion:1,expectedStockVersion:0,receivedQuantity:'5.125'});
  const first=await invoke('complete',q,who);
  await f.stock(b,{delta:'1',expectedVersion:1});
  const replay=await invoke('complete',q,who);
  assert.deepEqual(replay,{...first,replayed:true});assert.equal(replay.transaction.quantity_after,'5.125');
  await assert.rejects(invoke('complete',f.command(b,{...q,idempotencyKey:randomUUID()}),who),{code:'task_conflict'});
  assert.deepEqual(await balance(b),{quantity:'6.125',version:2});
  assert.equal((await f.supplies.history(f.manager,f.A,b.id)).length,2);
  await assert.rejects(invoke('complete',{...q,receivedQuantity:'7'},who),{code:'idempotency_conflict'});
});
test('corrections append exact signed ledger deltas; no-op confirmations and original receipts remain audited',async()=>{
  const b=await f.newBin();await f.stock(b,{delta:'3.125'});
  const q=f.command(b,{countedQuantity:'2',expectedStockVersion:1});
  const corrected=await invoke('correct',q);
  assert.equal(corrected.transaction.delta,'-1.125');assert.equal(corrected.transaction.quantity_after,'2.000');
  const noOp=await invoke('correct',f.command(b,{countedQuantity:'2',expectedStockVersion:2}));
  assert.equal(noOp.transaction,null);assert.equal(noOp.event.detail.delta,'0.000');
  await invoke('correct',f.command(b,{countedQuantity:'2.001',expectedStockVersion:2}));
  assert.deepEqual(await invoke('correct',q),{...corrected,replayed:true});
  assert.deepEqual(await balance(b),{quantity:'2.001',version:3});
  const history=await f.supplies.history(f.manager,f.A,b.id);
  assert.deepEqual(history.map(x=>x.delta).sort(),['-1.125','0.001','3.125']);
  for(const table of ['replenishment_event','replenishment_par','replenishment_receipt','supply_stock_transaction'])
    await assert.rejects(f.owner(`DELETE FROM ${table}`),/append-only/);
});
test('many serialized completion retries preserve one ledger delta and one completion event; distinct-key contenders lose',async()=>{
  const {b,task}=await activeBin();
  await invoke('assign',f.command(b,{taskId:task.id,expectedTaskVersion:0}));
  const q=f.command(b,{taskId:task.id,expectedTaskVersion:1,expectedStockVersion:0,receivedQuantity:'1.001'});
  const retries=await Promise.all(Array.from({length:16},()=>invoke('complete',q)));
  assert.equal(retries.filter(x=>!x.replayed).length,1);
  assert.equal(new Set(retries.map(x=>x.transaction.id)).size,1);
  assert.deepEqual(await balance(b),{quantity:'1.001',version:1});
  assert.equal((await f.owner("SELECT count(*)::int AS n FROM replenishment_event WHERE task_id=$1 AND kind='completed'",[task.id])).rows[0].n,1);
  await assert.rejects(invoke('complete',{...q,idempotencyKey:randomUUID()}),{code:'task_conflict'});
  await assert.rejects(f.auth.run(f.manager,{organizationId:f.A,permission:'supplies:write'},c=>c.query(
    "UPDATE replenishment_task SET status='assigned',completed_at=NULL,version=version+1 WHERE id=$1",[task.id])),/invalid replenishment transition/);
});
test('guessed foreign bin/task IDs and direct receipt/event reads remain isolated with memberships in both test organizations',async()=>{
  const {b,task}=await activeBin(),who=f.request('outsider');
  const sku=await f.supplies.createSku(who,f.B,{code:'SYN-OTHER-TENANT',name:'Synthetic foreign supply',unit:'each'});
  const other=await f.supplies.createBin(who,f.B,{skuId:sku.id,locationId:f.B,code:'SYN-OTHER-BIN'});
  await f.service.configure(who,f.B,f.command(other,{parQuantity:'1',expectedPolicyVersion:0}));
  await assert.rejects(f.service.assign(who,f.B,f.command(other,{taskId:task.id,expectedTaskVersion:0})),{code:'task_not_found'});
  await assert.rejects(f.service.correct(who,f.B,f.command(b,{countedQuantity:'1',expectedStockVersion:0})),{code:'bin_not_found'});
  assert.deepEqual((await f.service.listBins(who,f.B)).items.map(x=>x.id),[other.id]);
  await f.auth.run(who,{organizationId:f.B,permission:'supplies:write'},async c=>{
    for(const table of ['replenishment_par','replenishment_task','replenishment_event','replenishment_receipt'])
      assert.equal((await c.query(`SELECT * FROM ${table} WHERE organization_id=$1`,[f.A])).rows.length,0);
  });
});
test('zero-receipt closure is explicit/audited; continued low stock permits a new alert, never a duplicate active one',async()=>{
  const {b,task}=await activeBin();await invoke('assign',f.command(b,{taskId:task.id,expectedTaskVersion:0}));
  const result=await invoke('complete',f.command(b,{taskId:task.id,expectedTaskVersion:1,expectedStockVersion:0,receivedQuantity:'0'}));
  assert.equal(result.transaction,null);assert.equal(result.event.detail.receivedQuantity,'0.000');
  assert.deepEqual(await balance(b),{quantity:'0.000',version:0});
  const next=await invoke('detect',f.command(b));assert.notEqual(next.task.id,task.id);
});
test('stale stock fails without completing work; injected failure after ledger insert rolls back all state and receipts',async()=>{
  const {b,task}=await activeBin();await invoke('assign',f.command(b,{taskId:task.id,expectedTaskVersion:0}));
  await f.stock(b);
  const stale=f.command(b,{taskId:task.id,expectedTaskVersion:1,expectedStockVersion:0,receivedQuantity:'3'});
  await assert.rejects(invoke('complete',stale),{code:'stock_conflict'});
  const q={...stale,expectedStockVersion:1,idempotencyKey:randomUUID()};
  f.setAfterQuery(statement=>{if(statement.startsWith('INSERT INTO public.replenishment_receipt'))throw Error('synthetic failure after receipt insert');});
  try{await assert.rejects(invoke('complete',q),/synthetic failure/);}finally{f.setAfterQuery(null);}
  assert.deepEqual(await balance(b),{quantity:'1.125',version:1});
  assert.equal((await f.owner('SELECT status FROM replenishment_task WHERE id=$1',[task.id])).rows[0].status,'assigned');
  assert.equal((await f.owner("SELECT count(*)::int AS n FROM replenishment_event WHERE task_id=$1 AND kind='completed'",[task.id])).rows[0].n,0);
  assert.equal((await f.owner('SELECT count(*)::int AS n FROM replenishment_receipt WHERE idempotency_key=$1',[q.idempotencyKey])).rows[0].n,0);
  await invoke('complete',q);assert.deepEqual(await balance(b),{quantity:'4.125',version:2});
});
test('existing roles, tenant RLS, actor binding, membership revocation and audit restrictions apply to every operation',async()=>{
  const {b,task}=await activeBin(), q=f.command(b);
  for(const method of ['configure','detect','assign','complete','correct']) {
    await assert.rejects(invoke(method,q,'viewer'),{status:403});
    await assert.rejects(invoke(method,q,'operator'),{status:403});
    await assert.rejects(invoke(method,q,'manager',f.B),{status:403});
  }
  await assert.rejects(f.service.listBins(null,f.A),{status:401});
  assert.equal((await f.service.listBins(f.request('viewer'),f.A)).canWrite,false);
  await assert.rejects(f.service.history(f.request('viewer'),f.A,b.id),{status:403});
  await assert.rejects(invoke('detect',q,'outsider',f.B),{code:'bin_not_found'});
  await assert.rejects(invoke('assign',{...q,taskId:randomUUID(),expectedTaskVersion:0}),{code:'task_not_found'});
  await f.auth.run(f.request('viewer'),{organizationId:f.A,permission:'inventory:read'},async c=>{
    assert.equal((await c.query('SELECT * FROM replenishment_receipt')).rows.length,0);
    assert.equal((await c.query('SELECT * FROM replenishment_event')).rows.length,0);
    assert.equal((await c.query('SELECT * FROM replenishment_task WHERE organization_id=$1',[f.B])).rows.length,0);
  });
  const assigned=await invoke('assign',{...q,taskId:task.id,expectedTaskVersion:0});
  await assert.rejects(invoke('complete',f.command(b,{taskId:task.id,expectedTaskVersion:1,expectedStockVersion:0,receivedQuantity:'1'}),'other'),{code:'task_conflict'});
  await f.owner('UPDATE auth_membership SET active=false WHERE organization_id=$1 AND user_id=$2',[f.A,f.users.manager]);
  try{await assert.rejects(invoke('assign',{...q,taskId:task.id,expectedTaskVersion:0}),{status:403});}
  finally{await f.owner('UPDATE auth_membership SET active=true WHERE organization_id=$1 AND user_id=$2',[f.A,f.users.manager]);}
  assert.equal(assigned.task.assignee_id,f.users.manager);
  await assert.rejects(f.auth.run(f.manager,{organizationId:f.A,permission:'supplies:write'},c=>c.query('UPDATE supply_bin_stock SET quantity=999')),/permission denied/);
  await assert.rejects(f.auth.run(f.manager,{organizationId:f.A,permission:'supplies:write'},c=>c.query('UPDATE replenishment_task SET bin_id=$1',[b.id])),/permission denied/);
});
test('policy updates are versioned, audited and replay-safe; active tasks retain original detection policy',async()=>{
  const {b,task}=await activeBin(), q=f.command(b,{parQuantity:'4',expectedPolicyVersion:1});
  const result=await invoke('configure',q);assert.equal(result.policy.version,2);
  assert.deepEqual(await invoke('configure',q),{...result,replayed:true});
  await assert.rejects(invoke('configure',f.command(b,{parQuantity:'3',expectedPolicyVersion:1})),{code:'policy_conflict'});
  assert.equal((await f.owner('SELECT par_version FROM replenishment_task WHERE id=$1',[task.id])).rows[0].par_version,1);
  assert.equal((await f.service.listBins(f.manager,f.A)).items.find(x=>x.id===b.id).par_quantity,'4.000');
});
test('bounded keyset pages, HTTP through real auth/SQL, JSON limits and safe error mapping without sockets',async()=>{
  const b=await f.newBin(),client=createReplenishmentClient({organizationId:f.A,fetchImpl:f.fetchImpl});
  const q=f.command(b,{countedQuantity:'1.001',expectedStockVersion:0});
  const first=await client.command('correct',q);assert.equal(first.transaction.quantity_after,'1.001');
  assert.equal((await client.command('correct',q)).replayed,true);
  await assert.rejects(client.command('correct',{...q,countedQuantity:'2'}),{status:409});
  const one=await f.service.listBins(f.manager,f.A,{limit:1});assert.equal(one.items.length,1);assert.ok(one.nextCursor);
  const two=await f.service.listBins(f.manager,f.A,{limit:1,after:one.nextCursor});assert.notEqual(one.items[0].id,two.items[0].id);
  const base=`/organizations/${f.A}/replenishment/`;
  assert.equal((await f.fetchImpl(base+'bins?limit=101')).status,400);
  assert.equal((await f.fetchImpl(base+'correct',{method:'POST',body:'{bad'})).status,400);
  assert.equal((await f.fetchImpl(base+'correct',{method:'POST',body:'x'.repeat(17000)})).status,413);
  assert.equal((await f.fetchImpl(base+'detect',{method:'GET'})).status,405);
  assert.equal((await f.fetchImpl(base+'bins',{headers:{'x-sv010-test-user':'viewer'}})).status,200);
  assert.equal((await f.fetchImpl(base+'correct',{method:'POST',body:JSON.stringify(q),headers:{'x-sv010-test-user':'viewer'}})).status,403);
  const saved=f.setAfterQuery;
  f.setAfterQuery(()=>{throw Error('private database detail');});
  try{const r=await f.fetchImpl(base+'bins');assert.equal(r.status,500);assert.deepEqual(await r.json(),{error:'internal_error'});}finally{saved(null);}
});
test('task-local down/up preserves shared ledger and auth',async()=>{
  const n=(await f.owner('SELECT count(*)::int AS n FROM supply_stock_transaction')).rows[0].n;
  await f.db.exec('RESET ROLE; BEGIN;'+f.sql('../migrations/0001_replenishment.down.sql')+'COMMIT;');
  assert.equal((await f.owner("SELECT to_regclass('replenishment_task') AS t")).rows[0].t,null);
  assert.equal((await f.owner('SELECT count(*)::int AS n FROM supply_stock_transaction')).rows[0].n,n);
  await f.db.exec('SET ROLE sv010_schema_owner; BEGIN;'+f.sql('../migrations/0001_replenishment.up.sql')+'COMMIT; RESET ROLE;');
});
