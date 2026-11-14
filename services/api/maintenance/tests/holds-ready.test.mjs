import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
let f;before(async()=>{f=await fixture();});after(async()=>{await f?.close();});
const ids=page=>page.body.items.map(item=>item.id);
const ready=(q='',who='viewer',org=f.orgs[0],cursor)=>f.call(who,`?view=ready&limit=1${q?`&q=${encodeURIComponent(q)}`:''}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{org});
const asset=(id,{org=f.orgs[0],status='available'}={})=>f.owner(`INSERT INTO equipment(organization_id,external_id,name,equipment_type_id,location_id,status,provenance)
 SELECT $1,$2,'Synthetic hold-query fixture',(SELECT id FROM equipment_type WHERE organization_id=$1),(SELECT id FROM location WHERE organization_id=$1),$3,'synthetic-fixture' RETURNING id`,[org,id,status]);
// Trusted in-memory fixture arrangements only: no operational clearance mapping or runtime mutation grants.
async function hold(id,kind,{org=f.orgs[0],active=true}={}){
 return (await f.owner(`INSERT INTO equipment_hold(organization_id,equipment_id,kind,reason,placed_by,active,cleared_by,cleared_at)
  SELECT $1,id,$3,'Synthetic hold history','synthetic-fixture',$4,CASE WHEN $4 THEN NULL ELSE 'synthetic-fixture' END,CASE WHEN $4 THEN NULL ELSE now() END
  FROM equipment WHERE organization_id=$1 AND external_id=$2 RETURNING id`,[org,id,kind,active])).rows[0].id;
}
const holdsFor=id=>f.owner(`SELECT h.* FROM equipment_hold h JOIN equipment e ON e.organization_id=h.organization_id AND e.id=h.equipment_id
 WHERE e.organization_id=$1 AND e.external_id=$2 ORDER BY h.id`,[f.orgs[0],id]);
const state=id=>f.owner('SELECT status,version,last_verified_at,last_verified_source FROM equipment WHERE organization_id=$1 AND external_id=$2',[f.orgs[0],id]);
const clearFixture=id=>f.owner("UPDATE equipment_hold SET active=false,cleared_by='synthetic-fixture',cleared_at=now() WHERE id=$1",[id]);

test('manager reproduction: active dirty hold excludes available EQ-1 at limit1 without changing status/version',async()=>{
 assert.deepEqual(ids(await ready()),['EQ-1']);const before=(await state('EQ-1')).rows;await hold('EQ-1','dirty');
 assert.deepEqual((await state('EQ-1')).rows,before);assert.deepEqual(before.map(row=>({status:row.status,version:row.version})),[{status:'available',version:0}]);
 const result=await ready();assert.equal(result.status,200);assert.deepEqual(ids(result),[]);assert.equal(result.body.nextCursor,null);
});
test('all four active hold kinds exclude equipment for every existing inventory role without changing history',async()=>{
 for(const kind of ['dirty','fault','maintenance','unknown']){
  const id=`KIND-${kind}`;await asset(id);await hold(id,kind);const before=(await holdsFor(id)).rows;
  for(const role of ['viewer','operator','supply_manager','equipment_manager','admin']){
   const out=await ready(id,role);assert.equal(out.status,200);assert.deepEqual(ids(out),[],`${kind}/${role}`);
  }
  assert.deepEqual((await holdsFor(id)).rows,before);assert.equal((await state(id)).rows[0].version,0);
 }
});
test('hold and assignment exclusion precede pagination; cleared history remains eligible and every page fills correctly',async()=>{
 for(let i=0;i<8;i++)await asset(`PAGE-${i}`,{status:i===6?'cleaning':'available'});
 await hold('PAGE-0','dirty');await hold('PAGE-1','fault');await hold('PAGE-2','maintenance');await hold('PAGE-2','unknown');
 await hold('PAGE-3','dirty',{active:false});await hold('PAGE-7','unknown');
 const request=(await f.owner("INSERT INTO request(organization_id,requested_by) VALUES ($1,'synthetic-fixture') RETURNING id",[f.orgs[0]])).rows[0].id;
 const line=(await f.owner(`INSERT INTO request_item(organization_id,request_id,line_no,equipment_type_id,state)
  SELECT $1,$2,1,id,'assigned' FROM equipment_type WHERE organization_id=$1 RETURNING id`,[f.orgs[0],request])).rows[0].id;
 await f.owner(`INSERT INTO item_assignment(organization_id,request_item_id,equipment_id,assigned_by)
  SELECT $1,$2,id,'synthetic-fixture' FROM equipment WHERE organization_id=$1 AND external_id='PAGE-4'`,[f.orgs[0],line]);
 const first=await ready('PAGE-');assert.equal(first.status,200);assert.deepEqual(ids(first),['PAGE-3']);assert.ok(first.body.nextCursor);
 const second=await ready('PAGE-','viewer',f.orgs[0],first.body.nextCursor);assert.equal(second.status,200);assert.deepEqual(ids(second),['PAGE-5']);assert.equal(second.body.nextCursor,null);
 assert.equal((await holdsFor('PAGE-3')).rows.length,1,'cleared hold history is retained');
});
test('clearing only one stacked fixture hold keeps equipment excluded; all-cleared history alone does not block',async()=>{
 await asset('STACK-1');const dirty=await hold('STACK-1','dirty'),fault=await hold('STACK-1','fault'),before=(await state('STACK-1')).rows;
 assert.deepEqual(ids(await ready('STACK-1')),[]);await clearFixture(dirty);assert.deepEqual(ids(await ready('STACK-1')),[]);
 await clearFixture(fault);assert.deepEqual(ids(await ready('STACK-1')),['STACK-1']);
 let history=(await holdsFor('STACK-1')).rows;assert.equal(history.length,2);assert.ok(history.every(row=>!row.active&&row.cleared_by&&row.cleared_at));
 await hold('STACK-1','unknown');assert.deepEqual(ids(await ready('STACK-1')),[]);history=(await holdsFor('STACK-1')).rows;assert.equal(history.length,3);assert.equal(history.filter(row=>row.active).length,1);
 assert.deepEqual((await state('STACK-1')).rows,before);assert.equal((await f.owner('SELECT count(*)::int AS n FROM hold_clearance_rule')).rows[0].n,0,'no role/clearance policy was configured');
});
test('same external IDs and hold reads remain tenant-isolated under actual inventory RLS',async()=>{
 await asset('TENANT-1');await asset('TENANT-1',{org:f.orgs[1]});await hold('TENANT-1','dirty');
 assert.deepEqual(ids(await ready('TENANT-1')),[]);assert.deepEqual(ids(await ready('TENANT-1','outsider',f.orgs[1])),['TENANT-1']);
 assert.equal((await ready('TENANT-1','outsider',f.orgs[0])).status,403);await hold('TENANT-1','fault',{org:f.orgs[1]});assert.deepEqual(ids(await ready('TENANT-1','outsider',f.orgs[1])),[]);
 const rows=await f.authorization.run({headers:{authorization:'Bearer viewer'}},{organizationId:f.orgs[0],permission:'inventory:read'},ctx=>ctx.query('SELECT organization_id FROM equipment_hold'));
 assert.ok(rows.rows.length);assert.ok(rows.rows.every(row=>row.organization_id===f.orgs[0]),'RLS also filters an unqualified fixture SELECT');
});
test('service completion/replay preserves independent holds and remains unavailable',async()=>{
 await hold('EQ-3','dirty');await hold('EQ-3','fault');const before=(await holdsFor('EQ-3')).rows;
 const options={method:'POST',body:{action:'record-service',expectedVersion:0,note:'Synthetic service step complete'},key:'held-service'};
 const out=await f.call('operator','/EQ-3/service',options);assert.equal(out.status,200);assert.equal(out.body.record.status,'cleaning');assert.equal(out.body.record.version,1);
 const replay=await f.call('operator','/EQ-3/service',options);assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);
 assert.deepEqual((await holdsFor('EQ-3')).rows,before);assert.deepEqual(ids(await ready('EQ-3')),[]);
});
test('missing hold SELECT privilege fails closed without ready records; fixture grants no hold mutation authority',async()=>{
 const privileges=await f.authorization.run({headers:{authorization:'Bearer viewer'}},{organizationId:f.orgs[0],permission:'inventory:read'},ctx=>ctx.query("SELECT has_table_privilege(current_user,'equipment_hold','SELECT') AS read,has_table_privilege(current_user,'equipment_hold','INSERT') AS place,has_table_privilege(current_user,'equipment_hold','UPDATE') AS clear"));
 assert.deepEqual(privileges.rows,[{read:true,place:false,clear:false}]);
 await f.owner('REVOKE SELECT ON equipment_hold FROM maintenance_fixture_runtime');
 try{const out=await ready();assert.equal(out.status,500);assert.deepEqual(out.body,{error:'internal_error'});}finally{await f.owner('GRANT SELECT ON equipment_hold TO maintenance_fixture_runtime');}
});
test('missing holds migration fails closed instead of silently falling back to status-only readiness',async()=>{
 const missing=await fixture({holds:false});try{const out=await missing.call('viewer','?view=ready&limit=1');assert.equal(out.status,500);assert.deepEqual(out.body,{error:'internal_error'});}finally{await missing.close();}
});
