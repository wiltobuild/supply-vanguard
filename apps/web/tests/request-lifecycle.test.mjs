import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequestApi,createRequestSession,quantities,canClear,RequestError,EvidenceError,prepareClearance,describeClearError} from '../requests/client.js';
import {mountRequests} from '../requests/view.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const line=(patch={})=>({lineNo:1,equipmentType:'pump',state:'assigned',version:0,demandCancelled:false,dispatchedAt:null,receivedAt:null,returnedAt:null,assignments:[{id:'a',equipmentId:'EQ-1',active:true,assignedBy:'synthetic',assignedAt:'2026-11-10T00:00:00Z'}],holds:[],history:[],...patch});
const record=items=>({id:'r',items,summary:{legacy:'must not be rendered'}});
const apiFor=(patch={})=>({read:async()=>record([line()]),list:async()=>({items:[{id:'r'}],nextCursor:null}),rules:async()=>({rules:[]}),lifecycle:async()=>({}),...patch});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('adapter preserves exact paths and unchanged create/claim/hold wire bodies',async()=>{
 const calls=[];const api=createRequestApi({organizationId:'synthetic org',transport:async(...args)=>{calls.push(args);return {};}});
 await api.create({items:[{equipmentType:'pump'},{equipmentType:'pump'}]});await api.claim('r',2,{equipmentId:'EQ-1',expectedVersion:8});await api.lifecycle('r',2,{action:'return',condition:'dirty',expectedVersion:2,commandKey:'k'});await api.clear('h');
 assert.equal(calls[0][0],'/organizations/synthetic%20org/requests');assert.equal(calls[0][1].body.items.length,2);assert.deepEqual(calls[1][1].body,{equipmentId:'EQ-1',expectedVersion:8});assert.equal(calls[2][0],'/organizations/synthetic%20org/requests/r/items/2/lifecycle');assert.equal(calls[3][1].body,undefined);
});
test('partial demand keeps cumulative delivery, missing custody and independent holds',()=>{
 const items=[line({state:'returned',receivedAt:'then',returnedAt:'now',assignments:[{active:false}],holds:[{kind:'dirty',active:true},{kind:'fault',active:true}]}),line({lineNo:2,state:'missing',receivedAt:'then',assignments:[{active:true}]}),line({lineNo:3,state:'cancelled',demandCancelled:true,assignments:[]})];
 assert.deepEqual(quantities(items),{requested:3,open:0,assigned:0,dispatched:0,received:0,returned:1,cancelled:1,missing:1,failed:0,delivered:2,demandCancelled:1});
 assert.equal(canClear(items[0].holds[0],'admin',[]),false);assert.equal(canClear(items[0].holds[0],'cleaner',[{kind:'dirty',role:'cleaner'}]),true);assert.equal(canClear(items[0].holds[1],'cleaner',[{kind:'dirty',role:'cleaner'}]),false);
});
test('uncertain lifecycle retry retains frozen key/body; later action receives fresh key',async()=>{
 const calls=[];let n=0;const api=apiFor({lifecycle:async(...args)=>{calls.push(structuredClone(args.slice(0,3)));if(calls.length===1)throw new RequestError('lost reply',{uncertain:true});}});
 const s=createRequestSession({api,key:()=>`key-${++n}`});await s.load('r');await s.transition('r',line(),'dispatch');assert.equal(s.state.retryable,true);
 await assert.rejects(s.transition('r',line(),'receive'),/Resolve/);await s.retry();assert.deepEqual(calls[0],calls[1]);await s.transition('r',line(),'receive');assert.notEqual(calls[2][2].commandKey,calls[0][2].commandKey);s.dispose();
});
test('uncertain create cannot be retried and blocks fresh actions until explicit reconciliation',async()=>{
 let calls=0;const s=createRequestSession({api:apiFor({create:async()=>{calls++;throw new RequestError('lost',{uncertain:true});}})});await s.load();await s.create({items:[{equipmentType:'pump'}]});assert.equal(s.state.retryable,false);await s.retry();assert.equal(calls,1);await assert.rejects(s.create({items:[]}),/Resolve/);await s.reconcile();assert.equal(s.state.uncertain,false);s.dispose();
});
test('pre-dispatch cancellation requires confirmation; post-dispatch uses retained server custody',async()=>{
 const sent=[];const item=line({state:'dispatched',dispatchedAt:'then',demandCancelled:true});const s=createRequestSession({api:apiFor({read:async()=>record([item]),lifecycle:async(...args)=>sent.push(args)})});await s.load('r');assert.throws(()=>s.transition('r',line(),'cancel'),/not in transit/);await s.transition('r',line(),'cancel',{confirmedNotInTransit:true});await s.transition('r',item,'cancel');assert.equal(s.state.request.items[0].assignments[0].active,true);assert.equal(s.state.request.items[0].state,'dispatched');assert.equal(sent.length,2);s.dispose();
});
test('repeated click issues one command and a conflict refreshes current version',async()=>{
 const pending=deferred();let calls=0;const s=createRequestSession({api:apiFor({read:async()=>record([line({version:7})]),lifecycle:async()=>{calls++;return pending.promise;}})});await s.load('r');const first=s.transition('r',line(),'dispatch');await s.transition('r',line(),'dispatch');assert.equal(calls,1);pending.reject(new RequestError('stale',{status:409}));await first;assert.equal(s.state.phase,'conflict');assert.equal(s.state.request.items[0].version,7);s.dispose();
});
test('new navigation and dispose ignore late async responses',async()=>{
 const old=deferred();const api=apiFor({read:async id=>id==='old'?old.promise:{...record([line()]),id}});const s=createRequestSession({api});const first=s.load('old');await s.load('new');old.resolve({...record([]),id:'old'});await first;assert.equal(s.state.request.id,'new');const wait=deferred();api.read=()=>wait.promise;const last=s.load('late');s.dispose();wait.resolve(record([line()]));await last;assert.equal(s.state.request,null);
});
test('access failure and role reset clear all protected data and pending writes',async()=>{
 for(const status of [401,403]){const api=apiFor();const s=createRequestSession({api});await s.load('r');api.read=async()=>{throw new RequestError('denied',{status});};await s.load('r');assert.equal(s.state.phase,'denied');assert.deepEqual(s.state.requests,[]);assert.equal(s.state.request,null);assert.deepEqual(s.state.rules,[]);s.reset();assert.equal(s.state.phase,'idle');s.dispose();}
});
test('late write success after session reset does not refetch or leak prior records',async()=>{
 const pending=deferred();let reads=0;const s=createRequestSession({api:apiFor({read:async()=>{reads++;return record([line()]);},lifecycle:()=>pending.promise})});await s.load('r');const write=s.transition('r',line(),'dispatch');s.reset();pending.resolve({});await write;assert.equal(reads,1);assert.equal(s.state.request,null);assert.equal(s.state.busy,false);s.dispose();
});
test('hold placement does not overwrite existing holds; clear refresh trusts only server response',async()=>{
 let holds=[{id:'dirty',kind:'dirty',active:true},{id:'fault',kind:'fault',active:true}];const s=createRequestSession({api:apiFor({read:async()=>record([line({holds})]),clear:async id=>{holds=holds.map(h=>h.id===id?{...h,active:false,clearedBy:'synthetic',clearedAt:'now'}:h);}})});await s.load('r');await s.clear('dirty');assert.equal(s.state.request.items[0].holds[1].active,true);assert.equal(s.state.request.items[0].holds[0].clearedBy,'synthetic');s.dispose();
});
test('422 preserves server truth and exposes blocked-readiness error without optimistic transition',async()=>{
 const s=createRequestSession({api:apiFor({lifecycle:async()=>{throw new RequestError('not_assignable',{status:422});}})});await s.load('r');await s.transition('r',line(),'dispatch');assert.equal(s.state.request.items[0].state,'assigned');assert.equal(s.state.error.status,422);assert.equal(s.state.uncertain,false);s.dispose();
});
test('pagination obtains every request and refuses repeated cursors',async()=>{
 let pages=0;const s=createRequestSession({api:apiFor({list:async()=>({items:[{id:'a'}],nextCursor:'next'}),page:async()=>{pages++;return {items:[{id:'b'}],nextCursor:'next'};}})});await s.load();assert.equal(s.state.phase,'error');assert.match(s.state.error.message,/Repeated/);assert.equal(pages,1);s.dispose();
});
// Minimal DOM boundary, not a real-browser layout or keyboard audit.
function rootStub(){const listeners=new Map(),status={focus(){this.focused=true;},setAttribute(){},textContent:''};let html='';const root={ownerDocument:{activeElement:null},classList:{add(){}},get innerHTML(){return html;},set innerHTML(v){html=v;},querySelectorAll:()=>[],querySelector:s=>s==='[data-status]'?status:null,contains:()=>true,replaceChildren(){html='';},addEventListener(k,fn){listeners.set(k,fn);},removeEventListener(k){listeners.delete(k);}};return {root,listeners,status};}
test('mount renders semantic controls, truthful quantities, escaped records and no invented roles',async()=>{
 const {root,listeners}=rootStub();const item=line({equipmentType:'<script>bad</script>',state:'missing',receivedAt:'then',demandCancelled:true,holds:[{id:'h',kind:'dirty',active:true}]});const view=mountRequests(root,{api:apiFor({read:async()=>record([item])}),permissions:['equipment:write']});await tick();await view.session.load('r');assert.match(root.innerHTML,/&lt;script&gt;/);assert.doesNotMatch(root.innerHTML,/<script>/);assert.match(root.innerHTML,/Assignment retained/);assert.match(root.innerHTML,/Delivered is cumulative/);assert.match(root.innerHTML,/data-clear="h"[^>]* disabled/);assert.match(root.innerHTML,/<label>/);assert.match(root.innerHTML,/aria-live="polite"/);assert.equal(listeners.size,3);view.dispose();assert.equal(listeners.size,0);assert.equal(root.innerHTML,'');
});
test('remount removes old listeners; role changes synchronously clear visible protected content',async()=>{
 const {root,listeners}=rootStub();const one=mountRequests(root,{api:apiFor()});await tick();await one.session.load('r');const two=mountRequests(root,{api:apiFor()});await tick();assert.equal(listeners.size,3);two.resetAccess();assert.equal(root.innerHTML,'');assert.equal(two.session.state.request,null);two.dispose();
});
test('focus fallback goes to status after a formerly focused action becomes unavailable',async()=>{
 const {root,status}=rootStub();root.ownerDocument.activeElement={getAttribute:name=>name==='data-focus'?'dispatch-1':null};const view=mountRequests(root,{api:apiFor()});await tick();assert.equal(status.focused,true);view.dispose();
});
test('synthetic contract journey: deliver two, cancel remainder, dirty return and missing preserve totals',async()=>{
 const items=[line({state:'open',assignments:[]}),line({lineNo:2,state:'open',assignments:[]}),line({lineNo:3,state:'open',assignments:[]})];
 const api=apiFor({read:async()=>structuredClone(record(items)),claim:async(id,n,body)=>{const i=items[n-1];i.state='assigned';i.assignments=[{equipmentId:body.equipmentId,active:true}];},lifecycle:async(id,n,body)=>{const i=items[n-1];assert.equal(body.expectedVersion,i.version);i.version++;if(body.action==='dispatch'){i.state='dispatched';i.dispatchedAt='synthetic';}if(body.action==='receive'){i.state='received';i.receivedAt='synthetic';}if(body.action==='cancel'){i.demandCancelled=true;if(!i.dispatchedAt){i.state='cancelled';i.assignments=[];}}if(body.action==='return'){i.state='returned';i.returnedAt='synthetic';i.assignments[0].active=false;i.holds.push({kind:body.condition,active:true});}if(body.action==='missing'){i.state='missing';i.holds.push({kind:'unknown',active:true});}}});
 const s=createRequestSession({api});await s.load('r');for(const n of [1,2]){await s.claim('r',n,{equipmentId:`EQ-${n}`,expectedVersion:0});await s.transition('r',s.state.request.items[n-1],'dispatch');await s.transition('r',s.state.request.items[n-1],'receive');}await s.transition('r',s.state.request.items[2],'cancel',{confirmedNotInTransit:true});await s.transition('r',s.state.request.items[0],'return',{condition:'dirty'});await s.transition('r',s.state.request.items[1],'missing');
 const q=quantities(s.state.request.items);assert.equal(q.delivered,2);assert.equal(q.cancelled,1);assert.equal(q.returned,1);assert.equal(q.missing,1);assert.equal(s.state.request.items[0].holds[0].kind,'dirty');assert.equal(s.state.request.items[1].assignments[0].active,true);s.dispose();
});
test('success followed by failed refresh never reports refreshed success or retries committed write',async()=>{
 let committed=false,writes=0;const s=createRequestSession({api:apiFor({read:async()=>{if(committed)throw Error('refresh unavailable');return record([line()]);},lifecycle:async()=>{committed=true;writes++;}})});await s.load('r');await s.transition('r',line(),'dispatch');assert.equal(s.state.phase,'error');assert.equal(s.state.request,null);await s.retry();assert.equal(writes,1);s.dispose();
});
test('exact retry remains attached to original request after newer navigation',async()=>{
 const sent=[];const s=createRequestSession({api:apiFor({read:async id=>({...record([line()]),id}),lifecycle:async(...args)=>{sent.push(args.slice(0,3));if(sent.length===1)throw new RequestError('uncertain',{uncertain:true});}})});await s.load('r');await s.transition('r',line(),'dispatch');await s.load('other');await s.retry();assert.deepEqual(sent[0],sent[1]);assert.equal(s.state.request.id,'r');s.dispose();
});
test('denied mutation erases all request, rule and retry state',async()=>{
 const s=createRequestSession({api:apiFor({lifecycle:async()=>{throw new RequestError('permission revoked',{status:403});}})});await s.load('r');await s.transition('r',line(),'dispatch');assert.equal(s.state.phase,'denied');assert.equal(s.state.request,null);assert.deepEqual(s.state.requests,[]);assert.deepEqual(s.state.rules,[]);assert.equal(s.state.retryable,false);s.dispose();
});
// Replacement-aware DOM boundary: discarded nodes really lose focus, and controls retain properties only when restored.
function replacingRoot(){
 const listeners=new Map();const doc={activeElement:null};let html='',nodes=[];
 function parse(value){nodes=[];for(const match of value.matchAll(/<(input|select|textarea|button|div)\b([^>]*)>/g)){const attrs={};for(const a of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g))attrs[a[1]]=a[2]??'';if(!('data-focus'in attrs)&&!('data-draft'in attrs)&&!('data-status'in attrs))continue;const node={dataset:{},type:attrs.type||'',value:'',checked:false,disabled:'disabled'in attrs,textContent:'',getAttribute:k=>attrs[k]??null,setAttribute(k,v){attrs[k]=v;},focus(){if(!this.disabled)doc.activeElement=this;}};for(const [k,v]of Object.entries(attrs))if(k.startsWith('data-'))node.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;nodes.push(node);}}
 const root={ownerDocument:doc,classList:{add(){}},contains:n=>nodes.includes(n),get innerHTML(){return html;},set innerHTML(value){if(nodes.includes(doc.activeElement))doc.activeElement=null;html=value;parse(value);},querySelectorAll(s){return s==='[data-draft]'?nodes.filter(n=>Object.hasOwn(n.dataset,'draft')):nodes.filter(n=>Object.hasOwn(n.dataset,'focus')||Object.hasOwn(n.dataset,'draft'));},querySelector(s){if(s==='[data-status]')return nodes.find(n=>Object.hasOwn(n.dataset,'status'));return null;},replaceChildren(){this.innerHTML='';},addEventListener(k,fn){listeners.set(k,fn);},removeEventListener(k){listeners.delete(k);}};
 return {root,doc,listeners,find:key=>nodes.find(n=>n.dataset.focus===key||n.dataset.draft===key)};
}
test('request identity scopes confirmations and condition drafts across create, selection and retry auto-navigation',async()=>{
 const dom=replacingRoot();let first=true;const api=apiFor({read:async id=>({...record([line({lineNo:3,state:'open',assignments:[]})]),id}),create:async()=>({id:'B'}),lifecycle:async()=>{if(first){first=false;throw new RequestError('lost',{uncertain:true});}}});const view=mountRequests(dom.root,{api,permissions:['equipment:write']});await tick();await view.session.load('A');dom.find('transit-3').checked=true;dom.find('condition-3').value='dirty';
 await view.session.create({items:[{equipmentType:'pump'}]});assert.equal(view.session.state.request.id,'B');assert.equal(dom.find('transit-3').checked,false);assert.equal(dom.find('condition-3').value,'');
 dom.find('transit-3').checked=true;await view.session.load('A');assert.equal(dom.find('transit-3').checked,false);await view.session.transition('A',view.session.state.request.items[0],'dispatch');await view.session.load('B');dom.find('transit-3').checked=true;dom.find('condition-3').value='fault';await view.session.retry();assert.equal(view.session.state.request.id,'A');assert.equal(dom.find('transit-3').checked,false);assert.equal(dom.find('condition-3').value,'');view.resetAccess();assert.equal(dom.root.innerHTML,'');view.dispose();
});
test('busy, refresh and success replacement renders preserve a connected focus target for every action family',async()=>{
 for(const key of ['create','assign-1','return-1','clear-h','dispatch-1']){const dom=replacingRoot();const pending=deferred();const item=line({state:'open',holds:[{id:'h',kind:'dirty',active:true}]});const view=mountRequests(dom.root,{api:apiFor({read:async()=>record([item]),rules:async()=>({rules:[{kind:'dirty',role:'synthetic'}]}),lifecycle:()=>pending.promise}),permissions:['equipment:write'],role:'synthetic'});await tick();await view.session.load('r');assert.ok(dom.find(key),key);dom.find(key).focus();const work=view.session.transition('r',item,'dispatch');assert.equal(dom.doc.activeElement?.dataset.focus,'status',key+' busy fallback');pending.resolve({});await work;assert.equal(dom.doc.activeElement?.dataset.focus,'status',key+' final retained focus');assert.equal(dom.root.contains(dom.doc.activeElement),true);view.dispose();}
});
test('late conflict refresh cannot overwrite newer navigation or reset',async()=>{
 for(const reset of [false,true]){let conflict=false;const pending=deferred();const api=apiFor({read:async id=>conflict&&id==='A'?pending.promise:{...record([line()]),id},lifecycle:async()=>{conflict=true;throw new RequestError('A conflict',{status:409});}});const s=createRequestSession({api});await s.load('A');const write=s.transition('A',line(),'dispatch');await tick();if(reset)s.reset();else await s.load('B');pending.resolve({...record([line()]),id:'A'});await write;assert.equal(s.state.phase,reset?'idle':'ready');assert.equal(s.state.request?.id,reset?undefined:'B');assert.equal(s.state.error,null);s.dispose();}
});
test('failed or denied conflict refresh preserves error/denied rather than claiming latest data loaded',async()=>{
 for(const status of [0,401,403]){let conflict=false;const s=createRequestSession({api:apiFor({read:async()=>{if(conflict)throw new RequestError('refresh failed',{status});return record([line()]);},lifecycle:async()=>{conflict=true;throw new RequestError('conflict',{status:409});}})});await s.load('r');await s.transition('r',line(),'dispatch');assert.equal(s.state.phase,status?'denied':'error');assert.equal(s.state.request,null);assert.equal(s.state.error.message,'refresh failed');s.dispose();}
});

// ---------------- SV-027: clearance evidence wiring against the PR #32 contract (schemaVersion 1) ----------------
// Synthetic only. The evidence is a recorded assertion; none of these tests (or the UI) says it is sufficient to clear a hold.
const OBSERVED=new Date(Date.now()-60000).toISOString();
const ev=(over={})=>({reference:'Cleaning log #12',observedAt:OBSERVED,...over});
const clearance=(over={})=>({basis:'evidence-v1',evidence:{id:'e1',schemaVersion:1,reference:'Cleaning log #12',observedAt:OBSERVED,note:null,recordedBy:'user:synthetic',recordedAt:'2026-11-10T10:00:00.000Z'},...over});
const reply=(over={})=>({hold:{id:'dirty',kind:'dirty',active:false,clearedBy:'user:synthetic',clearedAt:'2026-11-10T10:00:00.000Z',clearance:clearance()},replayed:false,summaryBasis:'current',summary:{blocked:true,activeKinds:['fault'],active:1,total:2},holds:[],...over});
const twoHolds=()=>[{id:'dirty',kind:'dirty',active:true,placedAt:'t',placedBy:'p'},{id:'fault',kind:'fault',active:true,placedAt:'t',placedBy:'p'}];
const counter=()=>{let n=0;return()=>`k-${++n}`;};
const keysOf=o=>Object.keys(o).sort().join(',');

test('the evidence command goes to /holds/:id/clearances with an Idempotency-Key header; the legacy clear is unchanged',async()=>{
 const calls=[];const api=createRequestApi({organizationId:'o',transport:async(...a)=>{calls.push(a);return {};}});
 const body=prepareClearance(ev());
 await api.clearWithEvidence('h 1',body,'key-1');await api.clear('h');
 assert.equal(calls[0][0],'/organizations/o/holds/h%201/clearances');assert.equal(calls[0][1].method,'POST');assert.deepEqual(calls[0][1].body,body);
 assert.deepEqual(calls[0][1].headers,{'Idempotency-Key':'key-1'});
 assert.equal(calls[1][0],'/organizations/o/holds/h/clear');assert.equal(calls[1][1].body,undefined);assert.equal(Object.hasOwn(calls[1][1],'headers'),false,'no header on the legacy command');
 // A transport failure of the new write is uncertain, exactly like the other writes.
 const failing=createRequestApi({organizationId:'o',transport:async()=>{throw new Error('socket closed');}});
 await assert.rejects(failing.clearWithEvidence('h',body,'k'),e=>e.uncertain===true);
});

test('evidence input is validated with the server rules; only a reference, a UTC time and a note can be sent; messages never echo the input',()=>{
 const NOW=Date.parse('2026-11-10T12:00:00Z');
 const body=prepareClearance({reference:'  Cleaning log #12 ',observedAt:' 2026-11-10T09:30:00Z ',note:'  wiped  '},NOW);
 assert.deepEqual(body,{schemaVersion:1,evidence:{reference:'Cleaning log #12',observedAt:'2026-11-10T09:30:00.000Z',note:'wiped'}});
 assert.equal(keysOf(body),'evidence,schemaVersion');assert.equal(keysOf(body.evidence),'note,observedAt,reference','no actor, tenant, role or authoritative time field exists');
 assert.equal(Object.hasOwn(prepareClearance({reference:'A',observedAt:'2026-11-10T09:30:00Z'},NOW).evidence,'note'),true===false,'an empty note is omitted');
 assert.equal(prepareClearance({reference:'A',observedAt:'2026-11-10T12:00:00.000Z'},NOW).evidence.observedAt,'2026-11-10T12:00:00.000Z','now is allowed');
 const bad=[[{reference:'',observedAt:'2026-11-10T09:30:00Z'},'reference'],[{reference:'<b>x</b>',observedAt:'2026-11-10T09:30:00Z'},'reference'],[{reference:'x'.repeat(129),observedAt:'2026-11-10T09:30:00Z'},'reference'],
  [{reference:'A',observedAt:''},'observedAt'],[{reference:'A',observedAt:'yesterday'},'observedAt'],[{reference:'A',observedAt:'2026-11-10T09:30:00+02:00'},'observedAt'],[{reference:'A',observedAt:'2026-02-31T09:30:00Z'},'observedAt'],
  [{reference:'A',observedAt:'2026-11-10T09:30:00.123456Z'},'observedAt'],[{reference:'A',observedAt:'2026-11-10T12:00:00.001Z'},'observedAt'],
  [{reference:'A',observedAt:'2026-11-10T09:30:00Z',note:'two\nlines'},'note'],[{reference:'A',observedAt:'2026-11-10T09:30:00Z',note:'x'.repeat(501)},'note']];
 for(const [input,field] of bad)assert.throws(()=>prepareClearance(input,NOW),e=>e instanceof EvidenceError&&e.field===field,JSON.stringify(input).slice(0,70));
 assert.throws(()=>prepareClearance({reference:'A',observedAt:'2026-11-10T09:30:00.123456Z'},NOW),/millisecond/i);
 const marker='SECRET-MARKER-9Q';
 for(const input of [{reference:`<${marker}>`,observedAt:'2026-11-10T09:30:00Z'},{reference:'A',observedAt:marker},{reference:'A',observedAt:'2026-11-10T09:30:00Z',note:`${marker}\n${marker}`}])assert.throws(()=>prepareClearance(input,NOW),e=>!e.message.includes(marker));
 assert.throws(()=>prepareClearance(undefined,NOW),EvidenceError);
});

test('first success: sends the exact body and a fresh key, records the returned evidence, and refreshes from the server',async()=>{
 const calls=[];let reads=0;
 const api=apiFor({read:async()=>{reads++;return record([line({holds:twoHolds().map(h=>h.id==='dirty'&&calls.length?{...h,active:false,clearedBy:'user:synthetic',clearedAt:'2026-11-10T10:00:00.000Z',clearance:clearance()}:h)})]);},
  rules:async()=>({rules:[{kind:'dirty',role:'cleaner'},{kind:'fault',role:'biomed'}]}),clearWithEvidence:async(...a)=>{calls.push(a);return reply();}});
 const s=createRequestSession({api,key:counter()});await s.load('r');
 await s.clearWithEvidence('dirty',ev({note:'wiped'}));
 const [holdId,body,key]=calls[0];
 assert.equal(holdId,'dirty');assert.equal(key,'k-1');assert.equal(body.schemaVersion,1);assert.equal(keysOf(body.evidence),'note,observedAt,reference');
 assert.doesNotMatch(JSON.stringify(calls[0]),/actor|tenant|organization|role|clearedBy|clearedAt|recordedBy/i,'nothing identity- or time-like is sent by the client');
 assert.equal(s.state.phase,'success');assert.equal(reads,2,'the screen refreshed from the server after the write');
 const last=s.state.lastClearance;
 assert.deepEqual([last.holdId,last.replayed,last.stackBasis,last.activeKinds],['dirty',false,'current',['fault']]);
 assert.equal(last.clearance.evidence.reference,'Cleaning log #12');assert.equal(last.clearance.basis,'evidence-v1');
 const holds=s.state.request.items[0].holds;assert.equal(holds[0].active,false);assert.equal(holds[1].active,true,'clearing one hold never clears another');
 s.dispose();
});

test('a replay is shown as the original receipt with the CURRENT stack, never as immutable history',async()=>{
 const replies=[reply(),reply({replayed:true,summary:{blocked:false,activeKinds:[],active:0,total:2}})];
 const api=apiFor({clearWithEvidence:async()=>replies.shift()});const s=createRequestSession({api,key:()=>'same-key'});await s.load('r');
 await s.clearWithEvidence('dirty',ev());const first=s.state.lastClearance;
 await s.clearWithEvidence('dirty',ev());const again=s.state.lastClearance;
 assert.equal(first.replayed,false);assert.equal(again.replayed,true);
 assert.deepEqual(again.clearance,first.clearance,'the receipt part is exactly the original');
 assert.deepEqual(first.activeKinds,['fault']);assert.deepEqual(again.activeKinds,[],'the stack part reflects the newer state');
 assert.equal(again.stackBasis,'current');
 const unlabelled=createRequestSession({api:apiFor({clearWithEvidence:async()=>{const r=reply();delete r.summaryBasis;return r;}}),key:counter()});await unlabelled.load('r');await unlabelled.clearWithEvidence('dirty',ev());
 assert.equal(unlabelled.state.lastClearance.stackBasis,'unlabelled','a response that does not say its stack is current is not presented as current');
 s.dispose();unlabelled.dispose();
});

test('role loss is a refusal, not a lost session; missing rule, validation and conflicts each get their own message',async()=>{
 const fail=(status,message,extra={})=>apiFor({read:async()=>record([line({holds:twoHolds()})]),clearWithEvidence:async()=>{throw new RequestError(message,{status,...extra});}});
 let s=createRequestSession({api:fail(403,'wrong_role'),key:counter()});await s.load('r');await s.clearWithEvidence('dirty',ev());
 assert.equal(s.state.phase,'error');assert.equal(s.state.clearIssue.kind,'role');assert.notEqual(s.state.request,null,'the screen is not wiped');
 assert.deepEqual([s.state.uncertain,s.state.retryable],[false,false]);s.dispose();
 // A real loss of access still clears everything.
 const api=fail(403,'wrong_role');s=createRequestSession({api,key:counter()});await s.load('r');api.read=async()=>{throw new RequestError('forbidden',{status:403});};await s.load('r');
 assert.equal(s.state.phase,'denied');assert.equal(s.state.request,null);s.dispose();
 // Other statuses on the new command.
 for(const [status,code,kind] of [[422,'no_clearance_rule','missing-rule'],[400,'invalid_request','validation'],[422,'evidence_invalid','validation']]){
  s=createRequestSession({api:fail(status,code),key:counter()});await s.load('r');await s.clearWithEvidence('dirty',ev());
  assert.equal(s.state.clearIssue.kind,kind,code);assert.equal(s.state.phase,'error');s.dispose();
 }
 for(const [code,kind] of [['hold_already_cleared','conflict'],['idempotency_conflict','key-conflict']]){
  let reads=0;const a=fail(409,code);const read=a.read;a.read=async(...x)=>{reads++;return read(...x);};
  s=createRequestSession({api:a,key:counter()});await s.load('r');await s.clearWithEvidence('dirty',ev());
  assert.equal(s.state.phase,'conflict',code);assert.equal(s.state.clearIssue.kind,kind);assert.equal(reads,2,'a conflict refreshes the latest records');s.dispose();
 }
 s=createRequestSession({api:fail(401,'unauthenticated'),key:counter()});await s.load('r');await s.clearWithEvidence('dirty',ev());assert.equal(s.state.phase,'denied');s.dispose();
 // The legacy command keeps its frozen behaviour: a 403 is treated as access loss.
 const legacy=apiFor({clear:async()=>{throw new RequestError('wrong_role',{status:403});}});s=createRequestSession({api:legacy});await s.load('r');await s.clear('dirty');assert.equal(s.state.phase,'denied');s.dispose();
 assert.deepEqual(Object.values({a:describeClearError({status:422,message:'no_clearance_rule'}).kind}),['missing-rule']);
 assert.equal(describeClearError({status:418,message:'secret'}).message.includes('secret'),false,'unknown errors do not echo their text');
});

test('invalid precision or any invalid evidence sends nothing and leaves the session untouched',async()=>{
 let sent=0;const api=apiFor({read:async()=>record([line({holds:twoHolds()})]),clearWithEvidence:async()=>{sent++;return reply();}});
 const s=createRequestSession({api,key:counter()});await s.load('r');const before=s.state;
 for(const input of [ev({observedAt:'2026-11-10T09:30:00.123456Z'}),ev({reference:''}),ev({observedAt:new Date(Date.now()+3600e3).toISOString()}),ev({note:'a\nb'})])
  assert.throws(()=>s.clearWithEvidence('dirty',input),EvidenceError);
 assert.equal(sent,0);assert.equal(s.state,before,'no state change, no busy flag, no key consumed');
 await s.clearWithEvidence('dirty',ev());assert.equal(sent,1);s.dispose();
});

test('an uncertain write retries the exact original body and key; a later action gets a new key; a fresh action waits for reconciliation',async()=>{
 const calls=[];let first=true;
 const api=apiFor({read:async()=>record([line({holds:twoHolds()})]),clearWithEvidence:async(...a)=>{calls.push(a);if(first){first=false;throw new RequestError('Connection lost',{uncertain:true});}return reply({replayed:true});}});
 const s=createRequestSession({api,key:counter()});await s.load('r');
 await s.clearWithEvidence('dirty',ev({note:'prepared'}));
 assert.deepEqual([s.state.uncertain,s.state.retryable,s.state.clearIssue.kind],[true,true,'uncertain']);
 await assert.rejects(s.clearWithEvidence('fault',ev()),/uncertain operation/i);          // blocked until the first is resolved
 assert.equal(calls.length,1);
 await s.retry();
 assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0],'identical hold, body and Idempotency-Key');assert.equal(calls[1][2],'k-1');
 assert.equal(s.state.lastClearance.replayed,true);
 await s.clearWithEvidence('fault',ev());assert.notEqual(calls[2][2],calls[0][2],'a new action uses a fresh key, never the earlier one');
 s.dispose();
});

test('cleanup: reset, dispose and access loss erase the clearance record, issue and pending command; late results leak nothing',async()=>{
 const gate=deferred();let reads=0;
 const api=apiFor({read:async()=>{reads++;return record([line({holds:twoHolds()})]);},clearWithEvidence:async()=>{await gate.promise;return reply();}});
 let s=createRequestSession({api,key:counter()});await s.load('r');
 const pending=s.clearWithEvidence('dirty',ev());await tick();s.reset();gate.resolve();await pending;await tick();
 assert.equal(s.state.lastClearance,null);assert.equal(s.state.request,null);assert.equal(reads,1,'no refetch after a reset');s.dispose();
 s=createRequestSession({api:apiFor({read:async()=>record([line({holds:twoHolds()})]),clearWithEvidence:async()=>reply()}),key:counter()});await s.load('r');await s.clearWithEvidence('dirty',ev());
 assert.notEqual(s.state.lastClearance,null);s.reset();assert.deepEqual([s.state.lastClearance,s.state.clearIssue],[null,null]);s.dispose();
 const a=apiFor({read:async()=>record([line({holds:twoHolds()})]),clearWithEvidence:async()=>reply()});s=createRequestSession({api:a,key:counter()});await s.load('r');await s.clearWithEvidence('dirty',ev());
 a.read=async()=>{throw new RequestError('forbidden',{status:403});};await s.load('r');assert.equal(s.state.phase,'denied');assert.equal(s.state.lastClearance,null);s.dispose();
});

test('view: evidence form only where the contract permits; legacy button labelled; recorded evidence escaped; legacy and unreported clearances labelled honestly',async()=>{
 const {root}=rootStub();
 const holds=[{id:'dirty',kind:'dirty',active:true,placedAt:'t',placedBy:'p'},{id:'fault',kind:'fault',active:true,placedAt:'t',placedBy:'p'},
  {id:'c1',kind:'maintenance',active:false,placedAt:'t',placedBy:'p',clearedAt:'c',clearedBy:'u',clearance:clearance({evidence:{...clearance().evidence,reference:'<img src=x onerror=1>',note:'<b>n</b>',recordedBy:'<i>u</i>'}})},
  {id:'c2',kind:'unknown',active:false,placedAt:'t',placedBy:'p',clearedAt:'c',clearedBy:'u',clearance:{basis:'legacy-no-additional-evidence',evidence:null}},
  {id:'c3',kind:'dirty',active:false,placedAt:'t',placedBy:'p',clearedAt:'c',clearedBy:'u'}];
 const view=mountRequests(root,{api:apiFor({read:async()=>record([line({holds})]),rules:async()=>({rules:[{kind:'dirty',role:'cleaner'}]})}),permissions:['equipment:write'],role:'cleaner'});
 await tick();await view.session.load('r');
 const html=root.innerHTML;
 assert.match(html,/<form data-evidence="dirty"[^>]*aria-label="Clear dirty hold with evidence"/);assert.doesNotMatch(html,/data-evidence="fault"/,'no form for a kind this role is not configured to clear');
 assert.match(html,/Clear dirty without evidence \(legacy\)/);assert.match(html,/name="reference"[^>]*required/);assert.match(html,/name="observedAt"[^>]*required/);assert.match(html,/Note \(optional/);
 assert.match(html,/not check them against any policy/);
 assert.match(html,/&lt;img src=x onerror=1&gt;/);assert.match(html,/&lt;b&gt;n&lt;\/b&gt;/);assert.match(html,/&lt;i&gt;u&lt;\/i&gt;/);assert.doesNotMatch(html,/<img|<b>n|<i>u/);
 assert.match(html,/evidence recorded: reference/);assert.match(html,/as asserted by the clearer/);
 assert.match(html,/cleared without additional evidence \(legacy clearance/);assert.match(html,/clearance evidence is not reported by this response/);
 const none=mountRequests(rootStub().root,{api:apiFor({read:async()=>record([line({holds})]),rules:async()=>({rules:[{kind:'dirty',role:'cleaner'}]})}),permissions:['equipment:write'],role:'someone-else'});await tick();await none.session.load('r');
 view.dispose();none.dispose();
});

test('view: invalid precision shows an accessible inline error and sends nothing; a valid submit shows the receipt and the current stack',async()=>{
 const {root,listeners}=rootStub();const sent=[];
 const api=apiFor({read:async()=>record([line({holds:twoHolds()})]),rules:async()=>({rules:[{kind:'dirty',role:'cleaner'}]}),clearWithEvidence:async(...a)=>{sent.push(a);return reply();}});
 const view=mountRequests(root,{api,permissions:['equipment:write'],role:'cleaner'});await tick();await view.session.load('r');
 const formFor=values=>({dataset:{evidence:'dirty'},elements:{namedItem:name=>({value:values[name]??''})}});
 const submit=values=>listeners.get('submit')({preventDefault(){},target:formFor(values)});
 submit({reference:'LOG-1',observedAt:'2026-11-10T09:30:00.123456Z'});await tick();
 assert.equal(sent.length,0);assert.match(root.innerHTML,/id="evidence-error-dirty" role="alert"/);assert.match(root.innerHTML,/millisecond/);
 assert.match(root.innerHTML,/name="observedAt"[^>]*aria-invalid="true" aria-describedby="evidence-error-dirty"/);assert.doesNotMatch(root.innerHTML,/name="reference"[^>]*aria-invalid/);
 submit({reference:'LOG-1',observedAt:OBSERVED});await tick();await tick();
 assert.equal(sent.length,1);assert.doesNotMatch(root.innerHTML,/evidence-error-dirty/,'the inline error is gone after a valid submit');
 assert.match(root.innerHTML,/data-last-clearance/);assert.match(root.innerHTML,/Holds still active on this equipment: FAULT/);assert.match(root.innerHTML,/current state when the server answered, not part of the receipt/);
 view.dispose();
});

test('view: role refusal and missing rule show fixed explanations and keep the records on screen',async()=>{
 for(const [status,code,text] of [[403,'wrong_role',/Your role is not the one configured/],[422,'no_clearance_rule',/No clearance role is configured/],[409,'idempotency_conflict',/no longer matches its earlier submission/]]){
  const {root,listeners}=rootStub();
  const api=apiFor({read:async()=>record([line({holds:twoHolds()})]),rules:async()=>({rules:[{kind:'dirty',role:'cleaner'}]}),clearWithEvidence:async()=>{throw new RequestError(code,{status});}});
  const view=mountRequests(root,{api,permissions:['equipment:write'],role:'cleaner'});await tick();await view.session.load('r');
  listeners.get('submit')({preventDefault(){},target:{dataset:{evidence:'dirty'},elements:{namedItem:n=>({value:{reference:'LOG-1',observedAt:OBSERVED}[n]??''})}}});await tick();await tick();await tick();
  assert.match(root.innerHTML,text,code);assert.doesNotMatch(root.innerHTML,new RegExp(`>${code}<`),'the raw code is not shown');assert.match(root.innerHTML,/Independent holds/,'records stay on screen');
  view.dispose();
 }
});

// ---------------- SV-035: instance ownership of a shared root, and read-only capability controls ----------------
// A root stand-in with REAL listener semantics (removeEventListener removes only the function it is given), unlike rootStub above.
function ownedRoot(){
  const handlers=new Map(),classes=new Set(),doc={activeElement:null};let html='';
  const status={focus(){this.focused=true;},setAttribute(){},textContent:''};
  const root={ownerDocument:doc,classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)},
    get innerHTML(){return html;},set innerHTML(v){html=v;},replaceChildren(){html='';},contains:n=>Boolean(n&&n.insideRoot),   // only elements flagged insideRoot belong to it
    querySelectorAll:()=>[],querySelector:q=>q==='[data-status]'?status:null,
    addEventListener(type,fn){if(!handlers.has(type))handlers.set(type,new Set());handlers.get(type).add(fn);},
    removeEventListener(type,fn){handlers.get(type)?.delete(fn);}};
  return {root,doc,classes,handlers,listenerCount:()=>[...handlers.values()].reduce((n,set)=>n+set.size,0),
    fire:(type,event)=>[...(handlers.get(type)??[])].forEach(fn=>fn(event))};
}
const mountOn=async(root,tag,extra={})=>{const view=mountRequests(root,{api:apiFor({read:async()=>({...record([line({lineNo:7,equipmentType:tag})]),id:tag})}),permissions:['equipment:write','inventory:read'],role:'cleaner',...extra});await tick();await view.session.load(tag);return view;};

test('a retained, already-disposed instance cannot empty, unregister or restyle the instance that replaced it',async()=>{
  const dom=ownedRoot(),outside={name:'external focus target'};
  const A=await mountOn(dom.root,'A'),B=await mountOn(dom.root,'B');
  assert.match(dom.root.innerHTML,/pump|B/);const before=dom.root.innerHTML;assert.ok(before.length>100);
  dom.doc.activeElement=outside;
  A.dispose();A.dispose();                                    // the host calls the old handle again, twice
  assert.equal(dom.root.innerHTML,before,'the newer instance\'s DOM is untouched');
  assert.ok(dom.classes.has('sv-requests'),'and its styling');
  assert.equal(dom.doc.activeElement,outside,'external focus is not moved');
  assert.notEqual(B.session.state.phase,'idle');assert.equal(B.session.state.requestId,'B','its session was not changed');
  assert.equal(dom.listenerCount(),3,'only the newer instance has listeners');
  // The newer instance is still the registered owner: mounting a third instance must dispose it (and only it).
  const C=await mountOn(dom.root,'C');
  assert.equal(dom.listenerCount(),3,'B\'s listeners were removed when C replaced it, so B was still registered');
  B.dispose();assert.match(dom.root.innerHTML,/./,'a stale B cannot empty C either');C.dispose();
  assert.equal(dom.root.innerHTML,'');assert.equal(dom.listenerCount(),0);
});
test('disposal is effective for the current owner and idempotent: a second call never touches content the host put there afterwards',async()=>{
  const dom=ownedRoot(),A=await mountOn(dom.root,'A');
  assert.ok(dom.root.innerHTML.length>100);A.dispose();
  assert.equal(dom.root.innerHTML,'');assert.equal(dom.listenerCount(),0);assert.equal(A.session.state.phase,'idle');
  dom.root.innerHTML='<p>content placed by the host</p>';dom.classes.add('host-class');
  A.dispose();A.resetAccess({permissions:[],role:null});
  assert.equal(dom.root.innerHTML,'<p>content placed by the host</p>');assert.ok(dom.classes.has('host-class'));
});
test('a stale resetAccess handle cannot clear, unregister or refocus a newer mount; the current handle still clears everything',async()=>{
  const dom=ownedRoot(),outside={name:'external'};
  const A=await mountOn(dom.root,'A'),B=await mountOn(dom.root,'B');
  const before=dom.root.innerHTML;dom.doc.activeElement=outside;
  A.resetAccess({permissions:[],role:null,equipment:[],equipmentTypes:[]});
  assert.equal(dom.root.innerHTML,before,'B\'s DOM is untouched');assert.equal(B.session.state.requestId,'B');assert.notEqual(B.session.state.phase,'idle','B\'s session was not reset');
  assert.equal(dom.doc.activeElement,outside);
  // B still behaves with its OWN permissions after the stale call (its controls were not switched to read-only).
  assert.match(dom.root.innerHTML,/data-action="dispatch"/);assert.doesNotMatch(dom.root.innerHTML.replace(/<button[^>]*data-action="dispatch"[^>]*>/g,m=>/disabled/.test(m)?'DISABLED':m),/DISABLED/,'B\'s buttons were not disabled by the stale call');
  // Current-instance access-loss cleanup is intact.
  B.resetAccess({permissions:[],role:null});
  assert.equal(B.session.state.phase,'idle');assert.equal(B.session.state.request,null);assert.doesNotMatch(dom.root.innerHTML,/Request B/);
  B.dispose();assert.equal(dom.listenerCount(),0);
});
test('a late protected write result for a replaced instance cannot repopulate the newer mount',async()=>{
  const dom=ownedRoot(),gate=deferred();
  const A=mountRequests(dom.root,{api:apiFor({read:async()=>record([line({holds:[{id:'dirty',kind:'dirty',active:true,placedAt:'t',placedBy:'p'}]})]),rules:async()=>({rules:[{kind:'dirty',role:'cleaner'}]}),clearWithEvidence:async()=>{await gate.promise;return {hold:{id:'dirty',active:false,clearance:null},replayed:false,summaryBasis:'current',summary:{activeKinds:[]},holds:[]};}}),permissions:['inventory:read','equipment:write'],role:'cleaner'});
  await tick();await A.session.load('r');
  const pending=A.session.clearWithEvidence('dirty',ev());await tick();
  const B=await mountOn(dom.root,'B');const before=dom.root.innerHTML;
  gate.resolve();await pending;await tick();
  assert.equal(dom.root.innerHTML,before);assert.equal(B.session.state.lastClearance,null);B.dispose();
});

// Capability projection: the component offers a mutation control only when BOTH the advertised capability and the configured role allow it.
const holdsForCapability=()=>[{id:'dirty',kind:'dirty',active:true,placedAt:'t',placedBy:'p'}];
const capabilityMount=async(options,apiExtra={})=>{
  const dom=ownedRoot(),calls={evidence:0,legacy:0};
  const api=apiFor({read:async()=>record([line({holds:holdsForCapability()})]),rules:async()=>({rules:[{kind:'dirty',role:'cleaner'}]}),
    clear:async()=>{calls.legacy++;return {};},clearWithEvidence:async()=>{calls.evidence++;return reply();},...apiExtra});
  const view=mountRequests(dom.root,{api,role:'cleaner',...options});await tick();await view.session.load('r');
  return {...dom,view,calls};
};
const submitEvidenceEvent=(dom,values={reference:'LOG-1',observedAt:OBSERVED})=>dom.fire('submit',{preventDefault(){},target:{dataset:{evidence:'dirty'},elements:{namedItem:n=>({value:values[n]??''})}}});
const clickLegacy=dom=>dom.fire('click',{target:{closest:()=>({insideRoot:true,disabled:false,dataset:{clear:'dirty'}})}});
test('explicit empty permissions and a missing projection are read-only: no clearance form, nothing submitted even for a matching role',async()=>{
  for(const [name,options] of [['explicit empty',{permissions:[]}],['missing projection',{}]]){
    const d=await capabilityMount(options);
    assert.doesNotMatch(d.root.innerHTML,/data-evidence=/,`${name}: no evidence form`);
    assert.match(d.root.innerHTML,/data-clear="dirty"[^>]* disabled/,`${name}: the legacy button is disabled`);
    submitEvidenceEvent(d);clickLegacy(d);await tick();await tick();
    assert.deepEqual(d.calls,{evidence:0,legacy:0},`${name}: no command was sent`);
    assert.doesNotMatch(d.root.innerHTML,/evidence-error-dirty/,`${name}: and no local error was invented`);
    d.view.dispose();
  }
});
test('clearance needs inventory:read or equipment:write together with a matching configured role; lifecycle controls need equipment:write',async()=>{
  const full=await capabilityMount({permissions:['inventory:read','equipment:write']});
  assert.match(full.root.innerHTML,/<form data-evidence="dirty"/);assert.doesNotMatch(full.root.innerHTML,/data-clear="dirty"[^>]* disabled/);
  submitEvidenceEvent(full);await tick();await tick();assert.equal(full.calls.evidence,1);
  clickLegacy(full);await tick();await tick();assert.equal(full.calls.legacy,1,'positive control: the legacy click helper really reaches the handler');
  full.view.dispose();
  const readOnlyMember=await capabilityMount({permissions:['inventory:read']});      // e.g. a viewer configured as the clearing role
  assert.match(readOnlyMember.root.innerHTML,/<form data-evidence="dirty"/,'a configured clearer without write capability can clear (the server route needs only inventory:read)');
  assert.match(readOnlyMember.root.innerHTML,/data-action="dispatch"[^>]* disabled/,'but lifecycle commands stay disabled');
  readOnlyMember.view.dispose();
  const writeOnly=await capabilityMount({permissions:['equipment:write']});          // the historical mutation gate also allows clearing (with a matching role)
  assert.match(writeOnly.root.innerHTML,/<form data-evidence="dirty"/);assert.doesNotMatch(writeOnly.root.innerHTML,/data-action="dispatch"[^>]* disabled/,'lifecycle controls are enabled by equipment:write');
  submitEvidenceEvent(writeOnly);await tick();await tick();assert.equal(writeOnly.calls.evidence,1);writeOnly.view.dispose();
  const unrelated=await capabilityMount({permissions:['audit:read','supplies:write']});     // neither clearance capability is advertised
  assert.doesNotMatch(unrelated.root.innerHTML,/data-evidence=/);assert.match(unrelated.root.innerHTML,/data-clear="dirty"[^>]* disabled/);
  submitEvidenceEvent(unrelated);clickLegacy(unrelated);await tick();assert.deepEqual(unrelated.calls,{evidence:0,legacy:0});unrelated.view.dispose();
  const wrongRole=await capabilityMount({permissions:['inventory:read','equipment:write'],role:'someone-else'});
  assert.doesNotMatch(wrongRole.root.innerHTML,/data-evidence=/,'a matching capability is not enough without the configured role');wrongRole.view.dispose();
});
test('changing the projection through resetAccess takes effect: sufficient becomes read-only, and back',async()=>{
  const d=await capabilityMount({permissions:['inventory:read','equipment:write']});
  assert.match(d.root.innerHTML,/<form data-evidence="dirty"/);
  d.view.resetAccess({permissions:[],role:'cleaner'});assert.equal(d.view.session.state.phase,'idle');
  await d.view.session.load('r');await tick();
  assert.doesNotMatch(d.root.innerHTML,/data-evidence=/);submitEvidenceEvent(d);clickLegacy(d);await tick();assert.deepEqual(d.calls,{evidence:0,legacy:0});
  d.view.dispose();
});
