import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEquipmentPolling} from '../src/equipment-polling.js';
import {createEquipmentApi,createEquipmentSession,EquipmentError} from '../src/equipment-api.js';
import {updateEquipmentFreshness} from '../src/equipment-freshness.js';
const minute=60000,observedAt='2026-11-05T00:00:00.000Z',epoch=Date.parse(observedAt);
const record={schemaVersion:1,id:'EQ-clock',name:'Synthetic monitor',modelKind:'monitor',locationId:'room-101',roomId:'room-101',status:'available',version:0,lastVerified:{locationId:'room-101',observedAt,source:'manual-check-in'},lastAdminEditAt:null,provenance:'synthetic-clock-test'};
// Minimal view boundary: controls throw if replaced or edited by a freshness tick.
function view(){
 const fields=Object.fromEntries(['data-verification-count','data-review-summary','data-review-empty','data-review-id','data-review-name','data-review-location','data-review-freshness'].map(key=>[key,{dataset:{},textContent:'',hidden:false}]));
 const freshness={dataset:{freshnessId:record.id},textContent:'',className:''},focused={value:'unsaved draft',selectionStart:4},button=fields['data-review-id'];
 const root={activeElement:focused,querySelector:selector=>fields[selector.slice(1,-1)]||null,querySelectorAll:selector=>selector==='[data-freshness-id]'?[freshness]:[],replaceChildren(){throw Error('A clock tick must not replace controls');}};
 return {root,fields,freshness,focused,button};
}
test('unchanged successful polls advance five/thirty-minute labels, counts and next-review content without replacing controls',async()=>{
 let clock=epoch,calls=0;const nodes=view();
 const session=createEquipmentSession({list:async()=>{calls++;return [record];}});await session.refresh();
 const poll=createEquipmentPolling({getSession:()=>session,now:()=>clock,onTick:now=>updateEquipmentFreshness(nodes.root,session.state.items,{now})});
 await poll.tick();assert.equal(nodes.freshness.textContent,'Location recently observed');assert.equal(nodes.fields['data-verification-count'].textContent,'0 need location verification');assert.equal(nodes.button.hidden,true);
 clock=epoch+5*minute;await poll.tick();assert.equal(nodes.freshness.textContent,'Location recently observed');
 clock++;await poll.tick();assert.equal(nodes.freshness.textContent,'Location observation aging');assert.equal(nodes.fields['data-verification-count'].textContent,'1 need location verification');assert.equal(nodes.button.hidden,false);assert.equal(nodes.button.dataset.reviewId,record.id);assert.equal(nodes.fields['data-review-name'].textContent,record.name);
 clock=epoch+30*minute;await poll.tick();assert.equal(nodes.freshness.textContent,'Location observation aging');
 clock++;await poll.tick();assert.equal(nodes.freshness.textContent,'Location needs verification');assert.equal(nodes.fields['data-review-freshness'].textContent,'Location needs verification');
 assert.equal(nodes.root.activeElement,nodes.focused);assert.equal(nodes.focused.value,'unsaved draft');assert.equal(nodes.focused.selectionStart,4);assert.equal(nodes.fields['data-review-id'],nodes.button);assert.ok(calls>=3);session.close();
});
test('503 poll failures recover automatically with bounded backoff and keep stale warning throughout retry',async()=>{
 let clock=0,calls=0,outage=true,inspectRetry=()=>{};
 const session=createEquipmentSession({list:async()=>{calls++;if(calls>1&&outage){inspectRetry();throw new EquipmentError('Synthetic outage',{status:503,code:'unavailable'});}return [record];}});
 await session.refresh();const poll=createEquipmentPolling({getSession:()=>session,now:()=>clock});await poll.tick();
 clock=5000;await poll.tick();assert.equal(calls,2);const staleWarning=session.state.error;assert.equal(session.state.phase,'error');assert.equal(session.state.items[0],record);
 inspectRetry=()=>{assert.equal(session.state.phase,'error');assert.equal(session.state.error,staleWarning);};
 for(clock=5001;clock<10000;clock++)await poll.tick();assert.equal(calls,2,'no hot loop during first retry delay');
 clock=10000;await poll.tick();assert.equal(calls,3);
 inspectRetry=()=>{assert.equal(session.state.phase,'error');assert.equal(session.state.error.status,503);};
 clock=19999;await poll.tick();assert.equal(calls,3);clock=20000;await poll.tick();assert.equal(calls,4);
 clock=39999;await poll.tick();assert.equal(calls,4);clock=40000;await poll.tick();assert.equal(calls,5);
 clock=69999;await poll.tick();assert.equal(calls,5);outage=false;clock=70000;await poll.tick();assert.equal(calls,6);assert.equal(session.state.phase,'ready');assert.equal(session.state.error,null);
 clock=75000;await poll.tick();assert.equal(calls,7,'successful recovery restores normal five-second polling');session.close();
});
test('network and 429 failures retry; auth failures and cancelled refreshes wait for explicit user recovery',async()=>{
 for(const error of [new EquipmentError('network'),new EquipmentError('timeout',{code:'timeout'}),new EquipmentError('rate limited',{status:429}),new EquipmentError('expired',{status:401}),new EquipmentError('forbidden',{status:403}),new EquipmentError('cancelled',{code:'cancelled'})]){
  let clock=0,calls=0;const session=createEquipmentSession({list:async()=>{if(++calls>1)throw error;return [record];}});await session.refresh();
  const poll=createEquipmentPolling({getSession:()=>session,now:()=>clock});await poll.tick();clock=5000;await poll.tick();clock=10000;await poll.tick();clock=20000;await poll.tick();
  assert.equal(calls,['network','timeout'].includes(error.code)||error.status===429?4:2);session.close();
 }
});
test('pending reads, hidden/offline clients and cancelled sessions never trigger overlapping background work',async()=>{
 let clock=0,calls=0,allowed=true,finish;const session=createEquipmentSession({list:async()=>{if(++calls===1)return [record];return new Promise(resolve=>{finish=resolve;});}});await session.refresh();
 const poll=createEquipmentPolling({getSession:()=>session,now:()=>clock,canRead:()=>allowed});await poll.tick();allowed=false;clock=5000;await poll.tick();assert.equal(calls,1);
 allowed=true;const pending=poll.tick();clock=100000;await poll.tick();assert.equal(calls,2);finish([record]);await pending;
 session.cancelRead();clock=200000;await poll.tick();assert.equal(calls,2);session.close();
});
test('503 from the HTTP adapter is classified for automatic polling recovery',async()=>{
 for(const json of [true,false]){
 let clock=0,calls=0;
 const wireRecord={...record};delete wireRecord.roomId;
 const api=createEquipmentApi({organizationId:'synthetic',token:'synthetic-test-only',fetcher:async()=>{calls++;return calls===2?(json?Response.json({error:'temporary'},{status:503}):new Response('Synthetic unavailable page',{status:503})):Response.json({items:[wireRecord],nextCursor:null});}});
 const session=createEquipmentSession(api);await session.refresh();const poll=createEquipmentPolling({getSession:()=>session,now:()=>clock});await poll.tick();clock=5000;await poll.tick();assert.equal(session.state.error.status,503);clock=10000;await poll.tick();assert.equal(calls,3);assert.equal(session.state.phase,'ready');session.close();
 }
});
