import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequestApi,createRequestSession,quantities,canClear,RequestError} from '../requests/client.js';
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
