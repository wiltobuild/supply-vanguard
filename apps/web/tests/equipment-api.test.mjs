import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createEquipmentApi,createEquipmentSession,EquipmentError} from '../src/equipment-api.js';
import {presentEquipment} from '../src/lib.js';
import {planPlacements,diffPlacements} from '../../../packages/scene/viewer/config.js';
import {startFixture} from './api-fixture.mjs';
import {createWebHandler} from '../serve.mjs';
let fixture;
before(async()=>{fixture=await startFixture();});
after(async()=>{await fixture?.close();});
const api=(options={})=>createEquipmentApi({...fixture,token:fixture.tokens.equipment_manager,...options});
const session=options=>createEquipmentSession(api(options));

test('two independent sessions read committed shared state; stale draft conflicts and preserves the winner',async()=>{
 const a=session(),b=session();await Promise.all([a.refresh(),b.refresh()]);
 const draft=b.state.items.find(i=>i.id==='EQ-001');
 await a.mutate('admin',draft.id,{expectedVersion:draft.version,status:'in-use',note:'Synthetic client A'});
 assert.equal(a.state.items.find(i=>i.id===draft.id).version,1);
 await assert.rejects(b.mutate('admin',draft.id,{expectedVersion:draft.version,status:'maintenance',note:'Synthetic client B'}),e=>e.status===409&&/Load the latest/.test(e.message));
 assert.equal(b.state.items.find(i=>i.id===draft.id).note,'Synthetic client A');
 await b.mutate('admin',draft.id,{expectedVersion:1,status:'cleaning',note:'Reviewed client B draft'});
 await a.refresh();assert.deepEqual(a.state.items,b.state.items);a.close();b.close();
});
test('reconnect refetches the authority after a failed network read; no browser cache substitutes for API state',async()=>{
 let offline=false;
 const a=session(),b=session({fetcher:(...args)=>{if(offline)throw Error('offline');return fetch(...args);}});
 await Promise.all([a.refresh(),b.refresh()]);offline=true;
 await a.mutate('admin','EQ-003',{expectedVersion:0,status:'in-use'});
 await assert.rejects(b.refresh(),/Cannot reach/);assert.equal(b.state.phase,'error');assert.equal(b.state.items.find(i=>i.id==='EQ-003').version,0);
 offline=false;await b.refresh();assert.equal(b.state.items.find(i=>i.id==='EQ-003').version,1);a.close();b.close();
});
test('competing HTTP commands with the same version commit exactly once and both clients converge',async()=>{
 const a=session(),b=session();await Promise.all([a.refresh(),b.refresh()]);
 const results=await Promise.allSettled([a.mutate('admin','EQ-006',{expectedVersion:0,status:'available',note:'Synthetic competing A'}),b.mutate('admin','EQ-006',{expectedVersion:0,status:'maintenance',note:'Synthetic competing B'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 await Promise.all([a.refresh(),b.refresh()]);assert.deepEqual(a.state.items,b.state.items);assert.equal(a.state.items.find(i=>i.id==='EQ-006').version,1);a.close();b.close();
});
test('status does not refresh physical confidence; observations map stable IDs into existing scene placements',async()=>{
 const a=session();await a.refresh();const original=a.state.items.find(i=>i.id==='EQ-007');
 await a.mutate('observe',original.id,{locationId:'room-102',source:'manual-check-in',observedAt:new Date(Date.now()-1000).toISOString()});
 const observed=a.state.items.find(i=>i.id===original.id),before=planPlacements([presentEquipment(original)]),after=planPlacements([presentEquipment(observed)],undefined,undefined,before);
 assert.deepEqual(diffPlacements(before,after).moved,[original.id]);assert.deepEqual(diffPlacements(before,after).retyped,[]);
 await a.mutate('admin',original.id,{expectedVersion:0,status:'maintenance'});
 const updated=a.state.items.find(i=>i.id===original.id);assert.deepEqual(updated.lastVerified,observed.lastVerified);assert.equal(updated.provenance,original.provenance);
 assert.equal(presentEquipment(updated).lastSeenAt,observed.lastVerified.observedAt);a.close();
});
test('replayed response cannot roll back a newer record: commands always refetch authoritative state',async()=>{
 const a=session();await a.refresh();const key='web-replay-stable';
 await a.mutate('admin','EQ-008',{expectedVersion:0,status:'in-use'},{key});
 await a.mutate('admin','EQ-008',{expectedVersion:1,status:'cleaning'});
 // Current main's real receipt replay returns the original snapshot, after a newer commit.
 const replay=await api().admin('EQ-008',{expectedVersion:0,status:'in-use'},{key});
 assert.equal(replay.replayed,true);assert.equal(replay.record.version,1);assert.equal(replay.record.status,'in-use');
 const b=session();
 await b.refresh();await b.mutate('admin','EQ-008',{expectedVersion:0,status:'in-use'},{key});
 assert.equal(b.state.items.find(i=>i.id==='EQ-008').version,2);assert.equal(b.state.items.find(i=>i.id==='EQ-008').status,'cleaning');a.close();b.close();
});
test('repeated clicks send one in-flight mutation; cancel/uncertain save requires a refresh before another write',async()=>{
 let start,release;const entered=new Promise(r=>{start=r;}),hold=new Promise(r=>{release=r;});let calls=0;
 const a=session({fetcher:async(url,options)=>{if(options.method==='PATCH'){calls++;start();await hold;}return fetch(url,options);}});
 await a.refresh();const first=a.mutate('admin','EQ-004',{expectedVersion:0,status:'cleaning'});await entered;
 await assert.rejects(a.mutate('admin','EQ-004',{expectedVersion:0,status:'maintenance'}),e=>e.code==='busy');
 a.cancelWrite();release();await assert.rejects(first,e=>e.uncertain&&e.code==='cancelled');assert.equal(calls,1);assert.equal(a.state.needsRefresh,true);
 await assert.rejects(a.mutate('admin','EQ-004',{expectedVersion:0,status:'maintenance'}),e=>e.code==='refresh_required');await a.refresh();assert.equal(a.state.needsRefresh,false);a.close();
});
test('a lost response after a real commit stays uncertain until refetch confirms the database state',async()=>{
 const a=session({fetcher:async(url,options)=>{const response=await fetch(url,options);if(options.method==='PATCH'&&response.ok)throw Error('synthetic lost response after commit');return response;}});
 await a.refresh();await assert.rejects(a.mutate('admin','EQ-005',{expectedVersion:0,status:'available'}),e=>e.uncertain&&e.code==='network');
 assert.equal(a.state.needsRefresh,true);assert.equal(a.state.items.find(i=>i.id==='EQ-005').version,0);
 await a.refresh();assert.equal(a.state.items.find(i=>i.id==='EQ-005').version,1);assert.equal(a.state.items.find(i=>i.id==='EQ-005').status,'available');assert.equal(a.state.needsRefresh,false);a.close();
});
test('real HTTP errors distinguish permission, expired identity and invalid transition',async()=>{
 const viewer=session({token:fixture.tokens.viewer});await viewer.refresh();await assert.rejects(viewer.mutate('admin','EQ-002',{expectedVersion:0,status:'cleaning'}),e=>e.status===403&&/permission/.test(e.message));viewer.close();
 const a=session();await a.refresh();await assert.rejects(a.mutate('admin','EQ-002',{expectedVersion:0,status:'available'}),e=>e.status===422);
 fixture.revoke();await assert.rejects(a.refresh(),e=>e.status===401&&/session expired/.test(e.message));a.close();
});
test('local web entry serves only public assets and reports a missing upstream explicitly',async()=>{
 const server=createServer(createWebHandler());server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 try{
  for(const path of ['/','/src/app.js','/src/equipment-api.js','/packages/domain/contracts.js','/ward/','/ward/assets/monitor.glb'])assert.equal((await fetch(base+path)).status,200,path);
  for(const path of ['/tests/api-fixture.mjs','/serve.mjs','/package.json','/.claims/SV-007.json'])assert.equal((await fetch(base+path)).status,404,path);
  const response=await fetch(base+'/organizations/synthetic/equipment');assert.equal(response.status,503);assert.equal((await response.json()).error,'api_not_configured');
  assert.throws(()=>createWebHandler({apiOrigin:'https://example.com'}),/loopback/);
 }finally{await new Promise(r=>server.close(r));}
});
test('pagination is complete and cancellation prevents late responses from repopulating a closed session',async()=>{
 const record=id=>({schemaVersion:1,id,name:'Synthetic monitor',modelKind:'monitor',locationId:'unknown-room',status:'available',version:0,lastVerified:null,lastAdminEditAt:null,provenance:'synthetic-test'});
 const seen=[];const client=createEquipmentApi({organizationId:'org',token:'synthetic',fetcher:async url=>{seen.push(url);return Response.json(seen.length===1?{items:[record('one')],nextCursor:'next /+'}:{items:[record('two')],nextCursor:null});}});
 assert.deepEqual((await client.list()).map(i=>i.id),['one','two']);assert.match(seen[1],/next%20%2F%2B/);
 let resolve;const late=createEquipmentSession({list:()=>new Promise(r=>{resolve=r;})});const pending=late.refresh();late.close();resolve([{id:'late'}]);await pending;assert.deepEqual(late.state.items,[]);
});
test('server and unreadable responses are explicit; timeout marks a write outcome uncertain',async()=>{
 for(const [response,status] of [[Response.json({error:'server'}, {status:500}),500],[new Response('Not found',{status:404}),404]]){
  const client=createEquipmentApi({organizationId:'org',token:'synthetic',fetcher:async()=>response});await assert.rejects(client.list(),e=>e instanceof EquipmentError&&e.status===status);
 }
 const client=createEquipmentApi({organizationId:'org',token:'synthetic',timeoutMs:5,fetcher:(_,o)=>new Promise((resolve,reject)=>{o.signal.addEventListener('abort',()=>reject(Error('aborted')));})});
 await assert.rejects(client.admin('id',{expectedVersion:0,status:'cleaning'},{key:'synthetic'}),e=>e.code==='timeout'&&e.uncertain);
});
test('app excludes browser inventory persistence and demo mutations; reconnect and WebGL fallback remain wired',()=>{
 const text=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');assert.doesNotMatch(text,/\b(localStorage|parseSaved|seedEquipment|updateEquipment)\b/);assert.match(text,/addEventListener\('online',refresh\)/);assert.match(text,/no-webgl/);assert.match(text,/Cancel edits/);assert.match(text,/locationId/);
});
