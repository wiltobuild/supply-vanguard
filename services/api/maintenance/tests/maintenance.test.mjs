import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
import {serviceEquipment} from '../service.mjs';
import {permits} from '../../auth/roles.mjs';
let f;before(async()=>{f=await fixture();});after(async()=>{await f?.close();});
const command=(who,id,action,expectedVersion,note,key)=>f.call(who,`/${id}/service`,{method:'POST',body:{action,expectedVersion,...(note!==undefined&&{note})},key});
const row=async id=>(await f.owner('SELECT * FROM equipment WHERE organization_id=$1 AND external_id=$2',[f.orgs[0],id])).rows[0];
const events=async id=>(await f.owner('SELECT ev.* FROM equipment_event ev JOIN equipment e ON e.id=ev.equipment_id AND e.organization_id=ev.organization_id WHERE e.organization_id=$1 AND e.external_id=$2',[f.orgs[0],id])).rows;

test('server uses existing permissions; no role or tenant exception',async()=>{
 assert.equal((await f.call('missing')).status,401);
 for(const role of ['viewer','operator','supply_manager','equipment_manager','admin']){
  assert.equal((await f.call(role)).status,200);
  assert.equal((await f.call(role,'/EQ-3/history')).status,permits(role,'audit:read')?200:403);
  const result=await command(role,'EQ-6','record-service',0,'Synthetic service',`role-${role}`);
  assert.equal(result.status,permits(role,'equipment:write')?422:403,role);
 }
 assert.equal((await f.call('admin','',{org:f.orgs[1]})).status,403);
 assert.equal((await f.call('outsider','',{org:f.orgs[0]})).status,403);
 assert.equal((await f.call('admin','/missing/history')).status,404);
 assert.equal((await f.call('admin','/EQ-3/history',{org:f.orgs[1]})).status,403);
});
test('ready filters unavailable and active assignments before pagination; query wildcards are literal',async()=>{
 const result=await f.call('viewer','?view=ready&limit=1');assert.equal(result.status,200);
 assert.deepEqual(result.body.items.map(i=>i.id),['EQ-1']);assert.equal(result.body.nextCursor,null);
 assert.equal((await f.call('viewer','?view=ready&q=%25')).body.items.length,0);
 assert.equal((await f.call('outsider','?view=ready&limit=1',{org:f.orgs[1]})).body.nextCursor!==null,true,'tenant two has its own two available assets');
});
test('start cleaning is audited/versioned, replay returns original snapshot, and service entries never release or refresh location',async()=>{
 const before=await row('EQ-1');
 const first=await command('operator','EQ-1','start-cleaning',0,'Synthetic cleaning started','clean-1');assert.equal(first.status,200);assert.equal(first.body.record.status,'cleaning');assert.equal(first.body.record.version,1);
 const entry=await command('operator','EQ-1','record-service',1,'Synthetic service step completed','step-1');assert.equal(entry.status,200);assert.equal(entry.body.record.status,'cleaning');assert.equal(entry.body.record.version,2);
 const replay=await command('operator','EQ-1','start-cleaning',0,'Synthetic cleaning started','clean-1');assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal(replay.body.record.version,1);
 assert.equal((await row('EQ-1')).version,2,'replay does not overwrite newer state');
 assert.equal((await command('operator','EQ-1','start-cleaning',0,'different','clean-1')).status,409);
 assert.equal((await command('equipment_manager','EQ-1','start-cleaning',0,'Synthetic cleaning started','clean-1')).status,409,'keys are tenant-wide, receipts remain actor private');
 const next=await row('EQ-1');assert.deepEqual(next.last_verified_at,before.last_verified_at);assert.equal(next.location_id,before.location_id);
 assert.equal((await events('EQ-1')).length,2);assert.equal((await f.call('viewer','?view=ready')).body.items.length,0);
});
test('unavailable, retired, unknown actions and supplied roles/status are never clearance routes',async()=>{
 for(const id of ['EQ-3','EQ-4','EQ-6'])for(const action of ['start-cleaning','start-maintenance'])assert.equal((await command('admin',id,action,0,undefined,`${id}-${action}`)).status,422);
 for(const action of ['finish','release','available','clear-fault','clear-unknown'])assert.equal((await command('admin','EQ-4',action,0,'Synthetic','invalid')).status,400);
 for(const extra of [{status:'available'},{role:'admin'},{actor:'forged'},{locationId:'elsewhere'}])assert.equal((await f.call('operator','/EQ-4/service',{method:'POST',body:{action:'record-service',expectedVersion:0,note:'Synthetic',...extra}})).status,400);
 assert.equal((await row('EQ-4')).status,'maintenance');assert.equal((await row('EQ-4')).version,0);
});
test('serialized embedded competing versions have one winner; note completion preserves maintenance',async()=>{
 const results=await Promise.all(Array.from({length:4},(_,i)=>command('operator','EQ-4','record-service',0,`Synthetic step ${i}`,`race-${i}`)));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409,409,409]);assert.equal((await row('EQ-4')).status,'maintenance');assert.equal((await events('EQ-4')).length,1);
});
test('start maintenance follows merged transition; assignment remains unavailable and unchanged',async()=>{
 const out=await command('equipment_manager','EQ-5','start-maintenance',0,'Synthetic maintenance entry','maint-5');assert.equal(out.status,200);assert.equal(out.body.record.status,'maintenance');
 const assigned=await command('operator','EQ-2','start-cleaning',0,undefined,'assigned-clean');assert.equal(assigned.status,200);
 assert.equal((await f.owner('SELECT count(*)::int AS n FROM item_assignment WHERE organization_id=$1 AND active',[f.orgs[0]])).rows[0].n,1);
});
test('same note is an acknowledged no-op; same key cannot target another asset',async()=>{
 const current=await row('EQ-4'),count=(await events('EQ-4')).length;
 const out=await command('operator','EQ-4','record-service',current.version,current.note,'no-op');assert.equal(out.status,200);assert.equal(out.body.changed,false);assert.equal((await events('EQ-4')).length,count);
 const other=await row('EQ-3');assert.equal((await command('operator','EQ-3','record-service',other.version,'Synthetic other target','no-op')).status,409);
 assert.equal((await row('EQ-3')).version,other.version);
});
test('immutable history preserves before/after notes, actor and exact cursor; operator cannot read it',async()=>{
 const one=await f.call('equipment_manager','/EQ-1/history?limit=1');assert.equal(one.status,200);assert.equal(one.body.items.length,1);assert.ok(one.body.nextCursor);
 const two=await f.call('equipment_manager',`/EQ-1/history?limit=1&cursor=${one.body.nextCursor}`);assert.equal(two.status,200);assert.equal(two.body.items.length,1);assert.notEqual(one.body.items[0].id,two.body.items[0].id);
 assert.equal(one.body.items[0].actor,`user:${f.users.operator}`);assert.ok(one.body.items[0].after.note.startsWith('Synthetic'));
 await assert.rejects(f.owner("DELETE FROM equipment_event WHERE organization_id=$1",[f.orgs[0]]),/append-only/);
 assert.equal((await f.call('operator','/EQ-1/history')).status,403);
});
test('failed audit rolls back equipment and receipt together',async()=>{
 await f.owner(`CREATE FUNCTION maintenance_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`);
 await f.owner('CREATE TRIGGER maintenance_fixture_failure BEFORE INSERT ON equipment_event FOR EACH ROW EXECUTE FUNCTION maintenance_fixture_failure()');
 const before=await row('EQ-3'),out=await command('operator','EQ-3','record-service',0,'Synthetic rollback','rollback');assert.equal(out.status,500);
 assert.equal((await row('EQ-3')).version,before.version);assert.equal((await row('EQ-3')).note,before.note);
 assert.equal((await f.owner("SELECT count(*)::int AS n FROM equipment_command_receipt WHERE idempotency_key='admin:maintenance:rollback'")).rows[0].n,0);
 await f.owner('DROP TRIGGER maintenance_fixture_failure ON equipment_event');
});
test('invalid requests are bounded and authorization precedes JSON parsing',async()=>{
 for(const path of ['?view=dirty','?limit=0','?limit=1.5','?view=ready&cursor=bad','?view=all&role=admin'])assert.equal((await f.call('viewer',path)).status,400);
 assert.equal((await f.call('viewer','/EQ-3/service',{method:'POST',body:'invalid JSON'})).status,403);
 assert.equal((await f.call('operator','/EQ-3/service',{method:'POST',body:'invalid JSON'})).status,400);
 assert.equal((await f.call('operator','/EQ-3/service',{method:'POST',body:'x'.repeat(17000)})).status,413);
 assert.equal((await f.call('operator','/EQ-3/service',{method:'POST',body:{},headers:{'content-type':'text/plain'}})).status,415);
 assert.equal((await f.call('operator','/EQ-3/service',{method:'POST',body:{action:'record-service',expectedVersion:0,note:'Synthetic'},key:'x'.repeat(89)})).status,400);
 assert.equal((await f.call('operator','/EQ-3/service?status=available',{method:'POST',body:{}})).status,400);
});
test('service errors leave tenant context reusable and another tenant untouched',async()=>{
 const other=await f.call('outsider','?view=all',{org:f.orgs[1]});assert.equal(other.status,200);assert.ok(other.body.items.every(r=>r.version===0));
 // Direct service call under the actual transaction boundary exercises guessed asset identity as well.
 await assert.rejects(f.authorization.run({headers:{authorization:'Bearer operator'}},{organizationId:f.orgs[0],permission:'equipment:write'},ctx=>serviceEquipment(ctx,'missing',{action:'start-cleaning',expectedVersion:0},{idempotencyKey:'missing'})),e=>e.status===404);
 assert.equal((await f.call('viewer')).status,200);
});
