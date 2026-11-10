// Controlled, synthetic collaborators only. No SQL fixture, server, network or provisioning imports.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createReplenishmentClient} from '../../../../apps/web/supplies/client.mjs';
import {mountSupplies} from '../../../../apps/web/supplies/view.mjs';

const organizationId='00000000-0000-4000-8000-000000000001';
const bodies=['<html>denied</html>','','{broken'];
for(const status of [401,403]) for(const operation of ['read','write']) {
  test(`client preserves authoritative ${status} on non-JSON ${operation} rejection`,async()=>{
    for(const body of bodies) {
      const client=createReplenishmentClient({organizationId,fetchImpl:async()=>new Response(body,{status})});
      await assert.rejects(operation==='read'?client.listBins():client.command('complete',{}),error=>{
        assert.equal(error.status,status);assert.equal(error.uncertain,false);
        assert.equal(error.message,status===401?'unauthenticated':'forbidden');return true;
      });
    }
  });
}
test('valid JSON rejection codes survive; invalid JSON shapes fall back to HTTP status',async()=>{
  for(const [status,body,message] of [[403,'{"error":"forbidden"}','forbidden'],[409,'{"error":"stock_conflict"}','stock_conflict'],
    [401,'null','unauthenticated'],[403,'[]','forbidden'],[403,'{"error":42}','forbidden']]) {
    const client=createReplenishmentClient({organizationId,fetchImpl:async()=>new Response(body,{status})});
    await assert.rejects(client.command('complete',{}),error=>error.status===status&&error.message===message&&!error.uncertain);
  }
});
test('network and 5xx writes and unreadable successful writes retain uncertainty',async()=>{
  for(const fetchImpl of [async()=>{throw Error('synthetic transport failure');},
    async()=>new Response('<html>gateway failure</html>',{status:502}),
    async()=>new Response('{"error":"internal_error"}',{status:500}),
    async()=>new Response('{broken',{status:201})]) {
    const client=createReplenishmentClient({organizationId,fetchImpl});
    await assert.rejects(client.command('complete',{}),error=>error.uncertain===true);
    await assert.rejects(client.listBins(),error=>error.uncertain===false);
  }
});

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(fn){for(let n=0;n<100;n++){if(fn())return;await tick();}assert.fail('Controlled UI did not settle');}
const bin={id:organizationId,name:'Synthetic private supply',code:'SYN-PRIVATE',unit:'each',quantity:'1.000',stock_version:1,par_quantity:'2.000',par_version:1,low_par:true};
function submit(page) {
  const form=[...page.window.document.querySelectorAll('form')].find(f=>f.getAttribute('aria-label').startsWith('Correct counted stock:'));
  assert.ok(form);form.parentElement.open=true;
  for(const [name,value] of Object.entries({countedQuantity:'3',reason:'Synthetic private draft'})) {
    form.elements.namedItem(name).value=value;
    form.elements.namedItem(name).dispatchEvent(new page.window.Event('input',{bubbles:true}));
  }
  form.dispatchEvent(new page.window.Event('submit',{bubbles:true,cancelable:true}));
}
async function uiFixture() {
  const page=new JSDOM('<!doctype html><html lang="en"><title>Synthetic access test</title><main id="root"></main></html>',{url:'https://synthetic.invalid/'});
  let mode='allowed',key=0;
  const commands=[];
  const client=createReplenishmentClient({organizationId,fetchImpl:async(url,options)=>{
    if(options.method==='POST') {
      commands.push(JSON.parse(options.body));
      if(mode==='lost')throw Error('Synthetic uncertain transport');
    }
    if(typeof mode==='number')return new Response('<html>denied</html>',{status:mode});
    const value=options.method==='POST'?{replayed:false}:url.endsWith('/bins')?{items:[bin],nextCursor:null,canWrite:true}:{items:[],nextCursor:null};
    return new Response(JSON.stringify(value),{status:200});
  }});
  const root=page.window.document.getElementById('root');
  const view=mountSupplies(root,{client,makeKey:()=>`synthetic-key-${++key}`});await view.ready;
  return {page,root,view,commands,setMode(value){mode=value;},close(){view.destroy();page.window.close();}};
}
for(const status of [401,403]) for(const action of ['read','write','pending retry']) {
  test(`DOM ${status} ${action} clears cached records, drafts and pending requests`,async()=>{
    const f=await uiFixture();
    try {
      assert.match(f.root.textContent,/Synthetic private supply/);
      if(action!=='write') {
        f.setMode('lost');submit(f.page);
        await until(()=>f.root.querySelector('[data-pending]'));
        assert.match(f.root.textContent,/Result unknown/);
      }
      f.setMode(status);
      if(action==='read')await f.view.refresh();
      else if(action==='write')submit(f.page);
      else f.root.querySelector('[data-pending] button').click();
      await until(()=>f.root.querySelector('[role=alert]').textContent.includes(status===401?'Sign in again':'Access denied'));
      assert.doesNotMatch(f.root.textContent,/Synthetic private supply|SYN-PRIVATE|Synthetic private draft/);
      assert.equal(f.root.querySelectorAll('article,form,[data-pending]').length,0);
      // A permitted reload must not restore the denied identity's draft or pending command/key.
      f.setMode('allowed');await f.view.refresh();
      assert.equal(f.root.querySelectorAll('[data-pending]').length,0);
      assert.ok([...f.root.querySelectorAll('input[name=reason]')].every(n=>n.value===''));
      const previous=f.commands.at(-1).idempotencyKey;
      submit(f.page);await until(()=>f.root.querySelector('[role=status]').textContent.startsWith('Saved.'));
      assert.notEqual(f.commands.at(-1).idempotencyKey,previous);
    } finally {f.close();}
  });
}
