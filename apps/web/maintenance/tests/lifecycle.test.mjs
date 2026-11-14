import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mountMaintenance} from '../panel.js';
import {createMaintenanceApi,MaintenanceError} from '../api.js';
const {JSDOM}=createRequire(new URL('../../../../services/api/maintenance/package.json',import.meta.url))('jsdom');
const record={schemaVersion:1,id:'SYN-001',name:'Synthetic monitor',modelKind:'monitor',status:'maintenance',version:1,locationId:'store',lastVerified:null,lastAdminEditAt:null,provenance:'synthetic-fixture'};
const page=()=>({items:[structuredClone(record)],nextCursor:'synthetic-next'});
const events=()=>({items:[{at:'2026-11-06T00:00:00Z',actor:'synthetic-actor',before:{status:'maintenance'},after:{status:'maintenance',note:'Synthetic private history'}}],nextCursor:'synthetic-history-next'});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const denial=(status,format)=>new Response(format==='html'?'<html>Forbidden</html>':format==='empty'?'':format==='invalid'?'{':JSON.stringify({error:'forbidden'}),{status,headers:{'Content-Type':format==='html'?'text/html':'application/json'}});
const apiFor=fetcher=>createMaintenanceApi({organizationId:'synthetic-org',token:'synthetic-session',fetcher});
const fixture=api=>{
 const dom=new JSDOM('<main id="root"></main>',{url:'http://synthetic.invalid/'}),root=dom.window.document.querySelector('#root');
 const panel=mountMaintenance(root,{api,keyFactory:()=> 'synthetic-fixed-key'});
 const el=selector=>root.querySelector(selector),event=(node,type)=>node.dispatchEvent(new dom.window.Event(type,{bubbles:true,cancelable:true}));
 return {root,dom,panel,el,event,draft(){el('textarea').value='Synthetic private draft';event(el('textarea'),'input');}};
};
function cleared(ui){
 assert.equal(ui.el('[data-items]').options.length,0);assert.equal(ui.el('textarea').value,'');assert.equal(ui.el('[data-events]').children.length,0);
 assert.equal(ui.el('[data-version]').textContent,'');assert.equal(ui.el('[data-detail]').textContent,'No matching equipment.');
 assert.equal(ui.el('[data-more]').hidden,true);assert.equal(ui.el('[data-history-more]').hidden,true);assert.equal(ui.el('[data-retry]').hidden,true);assert.equal(ui.el('[data-save]').disabled,true);
}

for(const status of [401,403,500])test(`pending read rejection ${status} after close resolves safely and cannot affect a remounted identity`,async()=>{
 const pending=deferred();let calls=0;
 const ui=fixture({list:()=>++calls===1?Promise.resolve(page()):pending.promise});await settle();ui.draft();
 const read=ui.panel.refresh();ui.panel.close();pending.reject(new MaintenanceError(`Old ${status}`,{status}));await assert.doesNotReject(read);assert.equal(ui.root.children.length,0);
 const replacement=mountMaintenance(ui.root,{api:{list:async()=>({items:[{...record,id:'SYN-NEW',name:'New synthetic identity'}],nextCursor:null})}});await settle();
 assert.equal(ui.el('[data-items]').value,'SYN-NEW');assert.equal(ui.el('[data-message]').textContent,'1 loaded.');
 assert.equal(ui.el('textarea').value,'');replacement.close();
});
test('pending initial read rejection after close leaves removed DOM empty',async()=>{
 const pending=deferred(),ui=fixture({list:()=>pending.promise});ui.panel.close();pending.reject(new MaintenanceError('Old denial',{status:403}));await settle();assert.equal(ui.root.children.length,0);
});
for(const outcome of ['success','denial'])test(`replaced root ignores old ${outcome} without needing the old owner to clear the new panel`,async()=>{
 const pending=deferred();let calls=0;const ui=fixture({list:()=>++calls===1?Promise.resolve(page()):pending.promise});await settle();const read=ui.panel.refresh();
 const replacement=mountMaintenance(ui.root,{api:{list:async()=>({items:[{...record,id:'SYN-NEW'}],nextCursor:null})}});await settle();
 if(outcome==='success')pending.resolve(page());else pending.reject(new MaintenanceError('Old authorization',{status:403}));await assert.doesNotReject(read);
 assert.equal(ui.el('[data-items]').value,'SYN-NEW');assert.equal(ui.el('[data-message]').textContent,'1 loaded.');
 ui.panel.close();assert.equal(ui.el('[data-items]').value,'SYN-NEW','old close cannot remove new identity DOM');replacement.close();
});

for(const status of [401,403])for(const format of ['html','empty','invalid','json'])test(`HTTP ${status} ${format} inventory denial keeps status and clears cached equipment, draft and history`,async()=>{
 let denied=false;const api=apiFor(async(url)=>url.includes('/history')?Response.json(events()):denied?denial(status,format):Response.json(page()));
 const ui=fixture(api);await settle();ui.draft();ui.el('[data-history]').click();await settle();assert.equal(ui.el('[data-events]').children.length,1);denied=true;
 await assert.rejects(api.list(),error=>error.status===status&&!error.uncertain);
 await ui.panel.refresh();cleared(ui);assert.match(ui.el('[data-message]').textContent,status===401?/Session expired/:/cannot perform/);ui.panel.close();
});
for(const status of [401,403])for(const format of ['html','empty'])test(`HTTP ${status} ${format} service denial clears sensitive caches and is a definite rejected write`,async()=>{
 const api=apiFor(async(url,options)=>options.method==='POST'?denial(status,format):url.includes('/history')?Response.json(events()):Response.json(page()));
 const ui=fixture(api);await settle();ui.draft();ui.el('[data-history]').click();await settle();
 ui.event(ui.el('[data-service]'),'submit');await settle();cleared(ui);assert.match(ui.el('[data-message]').textContent,status===401?/Session expired/:/cannot perform/);ui.panel.close();
});
for(const status of [401,403])for(const format of ['html','empty'])test(`HTTP ${status} ${format} history denial clears the data protected by that permission`,async()=>{
 let denied=false;const api=apiFor(async(url)=>url.includes('/history')?(denied?denial(status,format):Response.json(events())):Response.json(page()));
 const ui=fixture(api);await settle();ui.draft();ui.el('[data-history]').click();await settle();denied=true;ui.el('[data-history]').click();await settle();
 assert.equal(ui.el('[data-events]').children.length,0);assert.equal(ui.el('[data-history-more]').hidden,true);
 if(status===401)cleared(ui);else{assert.equal(ui.el('[data-items]').value,record.id);assert.equal(ui.el('textarea').value,'Synthetic private draft');assert.match(ui.el('[data-history-message]').textContent,/cannot perform/);}
 ui.panel.close();
});
test('expired session invalidates another in-flight inventory read, and later history cannot resurrect data',async()=>{
 const lateList=deferred(),lateHistory=deferred();let reads=0,histories=0;
 const ui=fixture({list:()=>++reads===1?Promise.resolve(page()):lateList.promise,history:()=>++histories===1?lateHistory.promise:Promise.reject(new MaintenanceError('Session expired',{status:401}))});await settle();
 ui.draft();ui.el('[data-history]').click();const read=ui.panel.refresh();ui.el('[data-history]').click();await settle();cleared(ui);
 lateList.resolve(page());lateHistory.resolve(events());await read;await settle();cleared(ui);assert.equal(ui.el('[data-message]').textContent,'Session expired');ui.panel.close();
});
test('newer history result wins over delayed denial and selection changes invalidate old history errors',async()=>{
 const late=deferred();let histories=0;const ui=fixture({list:async()=>({items:[record,{...record,id:'SYN-002'}],nextCursor:null}),history:()=>++histories===1?late.promise:Promise.resolve(events())});await settle();
 ui.el('[data-history]').click();ui.el('[data-history]').click();await settle();late.reject(new MaintenanceError('Obsolete denial',{status:401}));await settle();assert.equal(ui.el('[data-events]').children.length,1);assert.equal(ui.el('[data-items]').value,record.id);
 const selectedLate=deferred();histories=0;const second=fixture({list:async()=>({items:[record,{...record,id:'SYN-002'}],nextCursor:null}),history:()=>selectedLate.promise});await settle();second.el('[data-history]').click();second.el('[data-items]').value='SYN-002';second.event(second.el('[data-items]'),'change');selectedLate.reject(new MaintenanceError('Old selection',{status:403}));await settle();assert.equal(second.el('[data-history-message]').textContent,'');assert.equal(second.el('[data-items]').value,'SYN-002');ui.panel.close();second.panel.close();
});
for(const failure of ['network','malformed-200','html-500','empty-503'])test(`${failure} uncertain write retains exact key/body and current errors remain visible`,async()=>{
 let writes=0;const sent=[];
 const api=apiFor(async(url,options)=>{
  if(options.method==='POST'){
   sent.push({url,key:options.headers['Idempotency-Key'],body:options.body});
   if(++writes===1){if(failure==='network')throw Error('Synthetic network');if(failure==='malformed-200')return new Response('{',{status:200});return denial(failure==='html-500'?500:503,failure==='html-500'?'html':'empty');}
   return Response.json({record,replayed:true,changed:false});
  }
  return Response.json(page());
 });
 const ui=fixture(api);await settle();ui.draft();ui.event(ui.el('[data-service]'),'submit');await settle();assert.equal(ui.el('[data-retry]').hidden,false);assert.equal(ui.el('[data-save]').disabled,true);assert.notEqual(ui.el('[data-message]').textContent,'Saving service entry…');
 await ui.panel.refresh();assert.equal(ui.el('[data-retry]').hidden,false);ui.el('[data-retry]').click();await settle();assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert.match(ui.el('[data-message]').textContent,/Service entry saved/);ui.panel.close();
});
test('current inventory and history server errors stay visible without deleting permitted drafts',async()=>{
 let failed=false;const ui=fixture({list:async()=>{if(failed)throw new MaintenanceError('Current inventory error',{status:500});return page();},history:async()=>{throw new MaintenanceError('Current history error',{status:500});}});await settle();ui.draft();failed=true;await ui.panel.refresh();assert.equal(ui.el('[data-message]').textContent,'Current inventory error');assert.equal(ui.el('textarea').value,'Synthetic private draft');ui.el('[data-history]').click();await settle();assert.equal(ui.el('[data-history-message]').textContent,'Current history error');ui.panel.close();
});
for(const outcome of ['success','error'])test(`delayed write ${outcome} after close cannot refetch or mutate a replacement identity`,async()=>{
 const pending=deferred();let reads=0;const ui=fixture({list:async()=>{reads++;return page();},service:()=>pending.promise});await settle();ui.draft();const oldNote=ui.el('textarea');ui.event(ui.el('[data-service]'),'submit');ui.panel.close();assert.equal(oldNote.value,'');
 const next=mountMaintenance(ui.root,{api:{list:async()=>({items:[{...record,id:'SYN-NEW'}],nextCursor:null})}});await settle();
 if(outcome==='success')pending.resolve({record,replayed:false});else pending.reject(new MaintenanceError('Old write failure',{status:403}));await settle();
 assert.equal(reads,1);assert.equal(ui.el('[data-items]').value,'SYN-NEW');assert.equal(ui.el('[data-message]').textContent,'1 loaded.');next.close();
});
test('session expiry invalidates a pending write result even when the server accepted it',async()=>{
 const pending=deferred();let reads=0;const ui=fixture({list:async()=>{reads++;return page();},service:()=>pending.promise,history:async()=>{throw new MaintenanceError('Expired session',{status:401});}});await settle();ui.draft();ui.event(ui.el('[data-service]'),'submit');ui.el('[data-history]').click();await settle();cleared(ui);
 pending.resolve({record,replayed:false});await settle();cleared(ui);assert.equal(reads,1);assert.equal(ui.el('[data-message]').textContent,'Expired session');ui.panel.close();
});
test('successful HTTP with unreadable body preserves its status and remains uncertain only for writes',async()=>{
 const api=apiFor(async()=>new Response('{',{status:200}));await assert.rejects(api.list(),error=>error.status===200&&!error.uncertain);
 await assert.rejects(api.service(record.id,{action:'record-service',expectedVersion:1,note:'Synthetic'},'same-key'),error=>error.status===200&&error.uncertain);
});
