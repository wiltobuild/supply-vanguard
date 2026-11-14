// Actual shared shell, handlers, auth/RLS and SQL, using streams instead of denied loopback listeners.
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {STATUSES,isStale} from '../../../packages/domain/equipment.js';
import {roomIds} from '../../../packages/domain/seed.js';
import * as lib from '../src/lib.js';
import {createEquipmentApi,createEquipmentSession} from '../src/equipment-api.js';
import {createEquipmentPolling} from '../src/equipment-polling.js';
import {updateEquipmentFreshness} from '../src/equipment-freshness.js';
import {mountMaintenance} from '../maintenance/panel.js';
import {createWebHandler} from '../serve.mjs';
import {startFixture} from './api-fixture.mjs';
const require=createRequire(new URL('../../../services/api/maintenance/package.json',import.meta.url)),{JSDOM}=require('jsdom'),{PGlite}=require('@electric-sql/pglite');
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8'),html=read('../index.html'),source=read('../src/app.js').replace(/^import .+;\r?\n/gm,'');
let f;before(async()=>{f=await startFixture({transport:'in-process',PGlite,maintenanceExamples:true});});after(async()=>{await f?.close();});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<500;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Mounted UI did not settle');}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function app({fetcher=f.fetcher,path='/?nowebgl#/maintenance'}={}){
 const dom=new JSDOM(html,{url:f.base+path,runScripts:'outside-only',pretendToBeVisual:true}),win=dom.window,ticks=[];let clock=0;
 win.setInterval=callback=>{ticks.push(callback);return ticks.length;};
 win.__deps={STATUSES,isStale,roomIds,...lib,createEquipmentApi:options=>createEquipmentApi({...options,base:f.base,fetcher}),createEquipmentSession,createEquipmentPolling:options=>createEquipmentPolling({...options,now:()=>clock}),updateEquipmentFreshness,mountMaintenance};
 win.eval(`(function({STATUSES,isStale,roomIds,presentEquipment,filterEquipment,describeFreshness,nextToReview,summarize,latestUpdate,webglAvailable,createEquipmentApi,createEquipmentSession,createEquipmentPolling,updateEquipmentFreshness,mountMaintenance}){${source}\n})(window.__deps);`);
 const el=selector=>win.document.querySelector(selector),event=(node,type)=>node.dispatchEvent(new win.Event(type,{bubbles:true,cancelable:true}));
 const refresh=()=>[...el('#connection').querySelectorAll('button')].find(button=>button.textContent==='Refresh').click();
 return {win,el,event,dom,refresh,
  async connect(role='equipment_manager',organization=f.organizationId){const form=el('#connection form');assert.ok(form);form.elements.organization.value=organization;form.elements.token.value=f.tokens[role];event(form,'submit');await until(()=>el('#connection').textContent.includes('Connected.'));},
  async route(name){win.location.hash=`#/${name}`;await until(()=>el(`.nav [data-route="${name}"]`)?.getAttribute('aria-current')==='page');},
  async tick(){clock+=6000;await Promise.all(ticks.map(callback=>callback()));await settle();},
  disconnect(){[...el('#connection').querySelectorAll('button')].find(button=>button.textContent==='Disconnect')?.click();},
  close(){this.disconnect();win.close();}
 };
}

test('public shell direct/reload routes, exact module assets and private asset denial through injected handler',async()=>{
 for(const path of ['/','/maintenance','/maintenance/']){const response=await f.fetcher(path);assert.equal(response.status,200);assert.match(await response.text(),/data-route="maintenance"/);}
 for(const path of ['/maintenance/api.js','/maintenance/panel.js','/maintenance/style.css','/packages/domain/contracts.js'])assert.equal((await f.fetcher(path)).status,200,path);
 for(const path of ['/maintenance/README.md','/maintenance/tests/web.test.mjs','/maintenance/evidence/desktop.png','/maintenance/index.html','/maintenance/../README.md','/services/api/maintenance/service.mjs'])assert.equal((await f.fetcher(path)).status,404,path);
 const ui=app({path:'/maintenance?nowebgl'});try{assert.equal(ui.win.document.title,'Maintenance · Supply Vanguard');await ui.connect();await until(()=>ui.el('[data-items]')?.options.length>0);assert.equal(ui.el('#maintenance-wrap').hidden,false);}finally{ui.close();}
});
test('shared available counts/search and maintenance ready view exclude held and assigned available assets',async()=>{
 const ui=app();try{
  await ui.connect();await until(()=>ui.el('[data-items]')?.value==='EQ-006');
  ui.el('[data-search] select').value='ready';ui.event(ui.el('form[data-search]'),'submit');await until(()=>ui.el('[data-items]').options.length===2&&!ui.el('[data-refresh]').disabled).catch(error=>{throw Error(JSON.stringify({message:ui.el('[data-message]').textContent,items:[...ui.el('[data-items]').options].map(o=>o.value),connection:ui.el('#connection').textContent}),{cause:error});});
  assert.deepEqual([...ui.el('[data-items]').options].map(option=>option.value),['EQ-007','EQ-008']);
  await ui.route('workspace');assert.match(ui.el('[data-ready-count]').textContent,/2 available, unassigned and unheld/);
  await ui.route('equipment');ui.el('#status-filter').value='available';ui.event(ui.el('#status-filter'),'change');assert.equal(ui.el('#asset-list').children.length,2);assert.ok(!ui.el('#asset-list').textContent.includes('EQ-001'));assert.ok(!ui.el('#asset-list').textContent.includes('EQ-003'));
 }finally{ui.close();}
});
test('service save dispatches actual auth/equipment/maintenance, refreshes shell and preserves unavailable status/history',async()=>{
 const ui=app();try{
  await ui.connect();await until(()=>ui.el('[data-items]')?.value==='EQ-006');ui.el('[data-service] textarea').value='Synthetic mounted service step';ui.event(ui.el('[data-service] textarea'),'input');ui.event(ui.el('[data-service]'),'submit');
  await until(()=>ui.el('[data-message]').textContent.includes('Service entry saved'));assert.match(ui.el('[data-detail]').textContent,/cleaning/);
  ui.el('[data-history]').click();await until(()=>ui.el('[data-events]').textContent.includes('Synthetic mounted service step'));
  const record=(await (await f.fetcher(`/organizations/${f.organizationId}/equipment/EQ-006`,{headers:{Authorization:`Bearer ${f.tokens.equipment_manager}`}})).json());assert.equal(record.status,'cleaning');assert.equal(record.lastVerified,null);
 }finally{ui.close();}
});
test('stable focused panel/draft through polls and repeated route, Back/Forward and remount keep one live panel',async()=>{
 const ui=app();try{
  await ui.connect();await until(()=>ui.el('[data-items]')?.value==='EQ-006');const note=ui.el('[data-service] textarea');note.value='Synthetic preserved draft';ui.event(note,'input');note.focus();await ui.tick();await ui.tick();assert.equal(ui.el('[data-service] textarea'),note);assert.equal(note.value,'Synthetic preserved draft');assert.equal(ui.win.document.activeElement,note);
  await ui.route('equipment');assert.equal(ui.el('#maintenance-wrap').children.length,0);ui.win.history.back();await until(()=>ui.el('.nav [data-route="maintenance"]').getAttribute('aria-current')==='page');await until(()=>ui.el('[data-items]')?.value==='EQ-006');assert.equal(ui.win.document.querySelectorAll('[data-service]').length,1);
  ui.win.history.forward();await until(()=>ui.el('.nav [data-route="equipment"]').getAttribute('aria-current')==='page');await ui.route('maintenance');await until(()=>ui.el('[data-items]')?.value==='EQ-006');assert.equal(ui.win.document.querySelectorAll('[data-service]').length,1);assert.equal(ui.el('[data-service] textarea').value,'');
 }finally{ui.close();}
});
test('audit-only403 and write403 remain permission errors, while malformed session401 clears shared identity',async()=>{
 let expire=false;const ui=app({fetcher:(url,options)=>expire?Promise.resolve(new Response('<html>Expired</html>',{status:401})):f.fetcher(url,options)});try{
  await ui.connect('operator');await until(()=>ui.el('[data-items]')?.value==='EQ-006');ui.el('[data-history]').click();await until(()=>ui.el('[data-history-message]').textContent.includes('cannot perform'));assert.ok(ui.el('[data-items]').options.length);assert.ok(!ui.el('#connection form'));
  ui.disconnect();await ui.connect('viewer');await until(()=>ui.el('[data-items]')?.value==='EQ-006');ui.el('[data-service] textarea').value='Synthetic denied edit';ui.event(ui.el('[data-service] textarea'),'input');ui.event(ui.el('[data-service]'),'submit');await until(()=>ui.el('[data-message]').textContent.includes('cannot perform'));assert.ok(!ui.el('#connection form'));
  expire=true;ui.refresh();await until(()=>!!ui.el('#connection form'));assert.equal(ui.el('[data-service]'),null);assert.ok(!ui.el('#maintenance-wrap').textContent.includes('Synthetic denied edit'));
 }finally{ui.close();}
});
for(const target of ['equipment','ready','panel'])test(`old ${target}401 after reconnect/organization replacement never clears new identity`,async()=>{
 const late=deferred(),started=deferred();let blocked=false;const newer=[];
 const ui=app({fetcher:(url,options)=>{
  const old=options.headers.Authorization===`Bearer ${f.tokens.equipment_manager}`;
  const matches=target==='equipment'?/\/equipment\?limit=100/.test(url):url.includes(`view=${target==='ready'?'ready':'cleaning'}`);
  if(old&&matches&&!blocked){blocked=true;started.resolve();return late.promise;}
  if(options.headers.Authorization===`Bearer ${f.tokens.other}`)newer.push(url);return f.fetcher(url,options);
 }});
 try{
  const connecting=ui.connect();await started.promise;ui.disconnect();await ui.connect('other',f.otherOrganizationId);await until(()=>ui.el('[data-items]')?.value==='EQ-006');const calls=newer.length;late.resolve(new Response('<html>Old session</html>',{status:401}));await connecting;await settle();assert.ok(!ui.el('#connection form'));assert.equal(ui.el('[data-items]').value,'EQ-006');assert.equal(newer.length,calls);
 }finally{late.resolve(new Response('',{status:401}));ui.close();}
});
test('old successful service response cannot refetch or mutate new identity UI',async()=>{
 const late=deferred(),started=deferred(),newer=[];
 const ui=app({fetcher:async(url,options)=>{
  if(options.headers.Authorization===`Bearer ${f.tokens.other}`)newer.push(url);
  const response=await f.fetcher(url,options);if(options.method==='POST'&&url.endsWith('/service')&&options.headers.Authorization===`Bearer ${f.tokens.equipment_manager}`){started.resolve();await late.promise;}return response;
 }});
 try{await ui.connect();await until(()=>ui.el('[data-items]')?.value==='EQ-006');ui.el('[data-service] textarea').value='Synthetic old committed step';ui.event(ui.el('[data-service] textarea'),'input');ui.event(ui.el('[data-service]'),'submit');await started.promise;ui.disconnect();await ui.connect('other',f.otherOrganizationId);await until(()=>ui.el('[data-items]')?.value==='EQ-006');const count=newer.length;late.resolve();await settle();await settle();assert.equal(newer.length,count);assert.equal(ui.el('[data-service] textarea').value,'');assert.ok(!ui.el('[data-message]').textContent.includes('Service entry saved'));}finally{late.resolve();ui.close();}
});
for(const status of [404,500,503])test(`canonical ready HTTP${status} produces unknown availability with no status-only fallback`,async()=>{
 const ui=app({fetcher:(url,options)=>url.includes('view=ready')?Promise.resolve(new Response('',{status})):f.fetcher(url,options)});try{
  await ui.connect();await ui.route('workspace');assert.equal(ui.el('[data-ready-count]').textContent,'Availability not verified');await ui.route('equipment');ui.el('#status-filter').value='available';ui.event(ui.el('#status-filter'),'change');assert.match(ui.el('#count').textContent,/not verified/);assert.ok(!ui.el('#asset-list').textContent.includes('EQ-001'));
 }finally{ui.close();}
});
test('separate inventory/ready version-status mismatch fails closed instead of inconsistent row/detail/count',async()=>{
 const record=(await (await f.fetcher(`/organizations/${f.organizationId}/equipment/EQ-007`,{headers:{Authorization:`Bearer ${f.tokens.equipment_manager}`}})).json());
 const ui=app({fetcher:(url,options)=>url.includes('view=ready')?Promise.resolve(Response.json({items:[{...record,version:1,status:'available'}],nextCursor:null})):/\/equipment\?limit=100/.test(url)?Promise.resolve(Response.json({items:[{...record,version:2,status:'cleaning'}],nextCursor:null})):f.fetcher(url,options)});
 try{await ui.connect();await ui.route('workspace');assert.equal(ui.el('[data-ready-count]').textContent,'Availability not verified');await ui.route('equipment');ui.el('#status-filter').value='available';ui.event(ui.el('#status-filter'),'change');assert.match(ui.el('#asset-list').textContent,/changed between reads/);assert.ok(!ui.el('#asset-list').textContent.includes('EQ-007'));}finally{ui.close();}
});
test('composite and injected web dispatch map malformed targets and unexpected handler errors without escaping',async()=>{
 for(const handler of [f.apiHandler,f.handler,createWebHandler({apiHandler:()=>{throw Error('private fixture failure');}}),createWebHandler({apiHandler:async()=>{throw Error('private asynchronous fixture failure');}})]){
  const response={headersSent:false,writeHead(code,headers){this.code=code;this.headers=headers;this.headersSent=true;return this;},end(body){this.body=JSON.parse(body);return this;}};
  await assert.doesNotReject(async()=>handler({url:handler===f.apiHandler?'http://[':handler===f.handler?'http://[':'/organizations/synthetic/equipment',method:'GET',headers:{}},response));
  assert.equal(response.code,handler===f.apiHandler||handler===f.handler?400:500);assert.ok(!JSON.stringify(response.body).includes('private fixture'));
 }
});
test('a newly held asset disappears from shared availability and invalidates an older maintenance ready view after polling',async()=>{
 const ui=app();try{
  await ui.connect();await until(()=>ui.el('[data-items]')?.value==='EQ-006');ui.el('[data-search] select').value='ready';ui.event(ui.el('form[data-search]'),'submit');await until(()=>ui.el('[data-items]').options.length===2&&!ui.el('[data-refresh]').disabled);
  await f.owner("INSERT INTO equipment_hold(organization_id,equipment_id,kind,placed_by) SELECT $1,id,'fault','synthetic-fixture' FROM equipment WHERE organization_id=$1 AND external_id='EQ-007'",[f.organizationId]);
  await ui.tick();await ui.tick();assert.equal(ui.el('[data-items]').options.length,0);assert.match(ui.el('[data-message]').textContent,/availability changed or is unverified/);
  ui.el('[data-refresh]').click();await until(()=>ui.el('[data-items]').options.length===1&&!ui.el('[data-refresh]').disabled);assert.equal(ui.el('[data-items]').value,'EQ-008');await ui.route('workspace');assert.match(ui.el('[data-ready-count]').textContent,/1 available, unassigned and unheld/);
 }finally{ui.close();}
});
test('shared availability adapter collects all canonical pages with the same session and excludes held/assigned IDs',async()=>{
 await f.owner(`INSERT INTO equipment(organization_id,external_id,name,equipment_type_id,location_id,status,provenance)
 SELECT $1,'READY-PAGE-'||lpad(n::text,2,'0'),'Synthetic pagination cart',equipment_type_id,location_id,'available','synthetic-fixture' FROM equipment CROSS JOIN generate_series(1,30) n WHERE organization_id=$1 AND external_id='EQ-008'`,[f.organizationId]);
 const calls=[],api=createEquipmentApi({organizationId:f.organizationId,token:f.tokens.equipment_manager,base:f.base,fetcher:(url,options)=>{calls.push({url,auth:options.headers.Authorization});return f.fetcher(url,options);}});
 const ready=await api.listReady();assert.equal(ready.length,31);assert.equal(new Set(ready.map(row=>row.id)).size,31);assert.ok(!ready.some(row=>['EQ-001','EQ-003','EQ-007'].includes(row.id)));assert.equal(calls.length,2);assert.ok(calls[1].url.includes('cursor='));assert.ok(calls.every(call=>call.auth===`Bearer ${f.tokens.equipment_manager}`));
});
