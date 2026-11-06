import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {mountMaintenance} from '../panel.js';
import {createMaintenanceApi,MaintenanceError} from '../api.js';
import {fixture} from '../../../../services/api/maintenance/tests/fixture.mjs';
const {JSDOM}=createRequire(new URL('../../../../services/api/maintenance/package.json',import.meta.url))('jsdom');
const asset=(id='EQ-1',status='cleaning',version=1)=>({id,name:'Synthetic monitor',status,version,locationId:'store',lastVerified:null,provenance:'synthetic-fixture'});
const tick=()=>new Promise(r=>setTimeout(r,10));
async function until(check){for(let i=0;i<200;i++){if(check())return;await tick();}assert.fail('UI state did not settle');}
const setup=api=>{const dom=new JSDOM('<main id="root"></main>',{url:'http://synthetic.invalid/'}),root=dom.window.document.querySelector('#root');let key=0;const panel=mountMaintenance(root,{api,keyFactory:()=>`synthetic-${++key}`});return {dom,root,panel,el:s=>root.querySelector(s),event:(node,type)=>node.dispatchEvent(new dom.window.Event(type,{bubbles:true,cancelable:true}))};};

test('accessible DOM preserves input and focus across history, refresh and conflict; explicit reviewed rebase',async()=>{
 let version=1,conflict=true;const calls=[];
 const api={list:async()=>({items:[asset('EQ-1','cleaning',version)],nextCursor:null}),history:async()=>({items:[{at:'2026-11-06T00:00:00Z',actor:'synthetic',before:{status:'cleaning'},after:{status:'cleaning',note:'<img src=x onerror=alert(1)>'}}],nextCursor:null}),service:async(id,body,key)=>{calls.push({id,body,key});if(conflict){version=2;throw new MaintenanceError('Conflict',{status:409});}version++;return {record:asset('EQ-1','cleaning',version),replayed:false};}};
 const ui=setup(api);await until(()=>ui.el('[data-items]').options.length===1&&!ui.el('[data-refresh]').disabled);
 const note=ui.el('textarea');note.value='Synthetic draft';ui.event(note,'input');note.focus();
 ui.el('[data-history]').click();await until(()=>ui.el('[data-events]').children.length===1);
 assert.equal(ui.dom.window.document.activeElement,note);assert.equal(ui.el('[data-events] img'),null,'history is text, never HTML');
 ui.event(ui.el('[data-service]'),'submit');await until(()=>ui.el('[data-message]').textContent==='Conflict');assert.equal(note.value,'Synthetic draft');assert.equal(ui.el('[data-save]').disabled,true);
 ui.el('[data-refresh]').click();await until(()=>!ui.el('[data-refresh]').disabled&&ui.el('[data-version]').textContent.includes('Current version 2'));
 assert.equal(note.value,'Synthetic draft');assert.match(ui.el('[data-version]').textContent,/draft based on version 1/);
 conflict=false;ui.el('[data-rebase]').click();ui.event(ui.el('[data-service]'),'submit');await until(()=>ui.el('[data-message]').textContent.includes('Service entry saved'));
 assert.equal(calls[1].body.expectedVersion,2);assert.equal(calls[1].body.note,'Synthetic draft');assert.equal(note.value,'');
 for(const input of ui.root.querySelectorAll('input,select,textarea'))assert.ok(input.closest('label'),'each form control has a native label');
 assert.ok(ui.el('[data-message][role="status"]'));assert.equal(ui.el('[data-service] select').options.length,1);assert.equal(ui.el('[data-service] select').value,'record-service');ui.panel.close();
});
test('uncertain writes keep exact command/key through refresh, then replay and refetch newer truth',async()=>{
 let count=0,readVersion=1;const calls=[];
 const ui=setup({list:async()=>({items:[asset('EQ-1','maintenance',readVersion)],nextCursor:null}),history:async()=>{throw new MaintenanceError('Forbidden',{status:403});},service:async(id,body,key)=>{calls.push({id,body:structuredClone(body),key});if(++count===1){readVersion=2;throw new MaintenanceError('Uncertain',{uncertain:true});}readVersion=3;return {record:asset('EQ-1','maintenance',2),replayed:true};}});
 await until(()=>!ui.el('[data-refresh]').disabled);
 ui.el('textarea').value='Synthetic work';ui.event(ui.el('textarea'),'input');ui.event(ui.el('[data-service]'),'submit');await until(()=>!ui.el('[data-retry]').hidden&&!ui.el('[data-retry]').disabled);
 assert.equal(ui.el('[data-save]').disabled,true);ui.el('[data-refresh]').click();await until(()=>ui.el('[data-version]').textContent.includes('Current version 2')&&!ui.el('[data-refresh]').disabled);
 assert.equal(ui.el('[data-save]').disabled,true);ui.el('[data-retry]').click();await until(()=>ui.el('[data-message]').textContent.includes('Service entry saved'));
 assert.deepEqual(calls[0],calls[1]);assert.match(ui.el('[data-version]').textContent,/Current version 3/);
 ui.el('[data-history]').click();await until(()=>ui.el('[data-history-message]').textContent==='Forbidden');assert.equal(ui.el('[data-save]').disabled,false);ui.panel.close();
});
test('loading, empty, error and disconnect states remain honest',async()=>{
 let release;const ui=setup({list:()=>new Promise(r=>{release=r;}),history:async()=>({items:[],nextCursor:null})});assert.equal(ui.el('[data-save]').disabled,true);
 release({items:[],nextCursor:null});await until(()=>ui.el('[data-detail]').textContent==='No matching equipment.');assert.equal(ui.el('[data-save]').disabled,true);ui.panel.close();assert.equal(ui.root.children.length,0);
 const bad=setup({list:async()=>{throw Error('Unavailable');}});await until(()=>bad.el('[data-message]').textContent==='Unavailable');assert.equal(bad.el('[data-save]').disabled,true);bad.panel.close();
 let late;const closed=setup({list:()=>new Promise(r=>{late=r;})});closed.panel.close();late({items:[asset()],nextCursor:null});await tick();assert.equal(closed.root.children.length,0);
});
test('authorization loss clears cached inventory/drafts; no-op saves are labeled honestly',async()=>{
 let denied=false;
 const ui=setup({list:async()=>{if(denied)throw new MaintenanceError('Access revoked',{status:403});return {items:[asset()],nextCursor:null};},service:async()=>({record:asset(),changed:false,replayed:false})});
 await until(()=>!ui.el('[data-refresh]').disabled);ui.el('textarea').value='Synthetic existing note';ui.event(ui.el('textarea'),'input');ui.event(ui.el('[data-service]'),'submit');await until(()=>ui.el('[data-message]').textContent.startsWith('No change:'));
 ui.el('textarea').value='Synthetic unsaved draft';ui.event(ui.el('textarea'),'input');denied=true;ui.el('[data-refresh]').click();await until(()=>ui.el('[data-message]').textContent==='Access revoked');assert.equal(ui.el('[data-items]').options.length,0);assert.equal(ui.el('textarea').value,'');assert.equal(ui.el('[data-save]').disabled,true);ui.panel.close();
});
test('API bounds requests, holds credentials only in headers and distinguishes uncertain responses',async()=>{
 const calls=[];const api=createMaintenanceApi({organizationId:'synthetic-org',token:'synthetic-session',fetcher:async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>({items:[],nextCursor:null})};}});
 await api.list({view:'ready',q:'monitor'});assert.match(calls[0].url,/view=ready/);assert.equal(calls[0].options.headers.Authorization,'Bearer synthetic-session');assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');assert.ok(!calls[0].url.includes('synthetic-session'));
 const fail=createMaintenanceApi({organizationId:'org',token:'session',fetcher:async()=>{throw Error('network');}});
 await assert.rejects(fail.service('EQ-1',{action:'record-service',expectedVersion:0,note:'Synthetic'},'key'),e=>e.uncertain);
 const five=createMaintenanceApi({organizationId:'org',token:'session',fetcher:async()=>({ok:false,status:500,json:async()=>({error:'internal_error'})})});
 await assert.rejects(five.service('EQ-1',{},'key'),e=>e.uncertain&&e.status===500);
});
test('web → adapter → handler → real auth/RLS → SQL → audit → refetch (in-process, synthetic)',async()=>{
 const f=await fixture();
 try{
  const fetcher=async(url,options)=>{
   const parsed=new URL(url,'http://synthetic.invalid'),prefix=`/organizations/${f.orgs[0]}/maintenance/equipment`,result=await f.call('operator',parsed.pathname.slice(prefix.length)+parsed.search,{method:options.method,body:options.body,key:options.headers['Idempotency-Key']});
   return {ok:result.status>=200&&result.status<300,status:result.status,json:async()=>result.body};
  };
  const ui=setup(createMaintenanceApi({organizationId:f.orgs[0],token:'synthetic',fetcher}));await until(()=>ui.el('[data-items]').value==='EQ-3'&&!ui.el('[data-refresh]').disabled);
  ui.el('textarea').value='Synthetic cleaning step finished';ui.event(ui.el('textarea'),'input');ui.event(ui.el('[data-service]'),'submit');await until(()=>ui.el('[data-message]').textContent.includes('Service entry saved'));
  assert.match(ui.el('[data-detail]').textContent,/cleaning/);assert.match(ui.el('[data-detail]').textContent,/Not yet verified/);
  assert.equal((await f.owner("SELECT count(*)::int AS n FROM equipment_event WHERE organization_id=$1",[f.orgs[0]])).rows[0].n,1);
  ui.el('[data-search] select').value='ready';ui.event(ui.el('[data-search]'),'submit');await until(()=>ui.el('[data-items]').value==='EQ-1'&&!ui.el('[data-refresh]').disabled);
  assert.deepEqual([...ui.el('[data-items]').options].map(o=>o.value),['EQ-1'],'cleaning, maintenance and active assignments never enter ready view');ui.panel.close();
 }finally{await f.close();}
});
test('preview follows shared responsive/focus direction and states mounting limitations',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8'),css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(html,/shared app does not mount it yet/);assert.match(html,/Synthetic examples only/);assert.match(css,/:focus-visible/);assert.match(css,/@media\(max-width:600px\)/);assert.match(css,/min-height:44px/);assert.ok(!css.includes('animation:'));
});
