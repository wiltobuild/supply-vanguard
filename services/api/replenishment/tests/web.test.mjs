import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import axe from 'axe-core';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixture.mjs';
import {mountSupplies} from '../../../../apps/web/supplies/view.mjs';
import {createReplenishmentClient} from '../../../../apps/web/supplies/client.mjs';

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(predicate){for(let i=0;i<150;i++){if(predicate())return;await tick();}assert.fail('UI did not settle');}
const dom=()=>new JSDOM('<!doctype html><html lang="en"><head><title>Synthetic supply test</title></head><body><main id="root"></main></body></html>',{runScripts:'outside-only',pretendToBeVisual:true,url:'https://synthetic-test.invalid/'});
const findForm=(d,label)=>[...d.querySelectorAll('form')].find(x=>x.getAttribute('aria-label').startsWith(label+':'));
function submit(d,label,values={}) {
  const form=findForm(d,label);assert.ok(form,label);
  form.parentElement.open=true;
  for(const [name,value] of Object.entries({reason:'Synthetic test only',...values})) {
    form.elements.namedItem(name).value=value;
    form.elements.namedItem(name).dispatchEvent(new d.defaultView.Event('input',{bubbles:true}));
  }
  form.dispatchEvent(new d.defaultView.Event('submit',{bubbles:true,cancelable:true}));
  return form;
}
test('accessible DOM workflow traverses mounted HTTP, auth, SQL, assignment, completion and audit without network',async()=>{
  const f=await fixture(),page=dom(),d=page.window.document;
  try {
    const b=await f.newBin();
    const client=createReplenishmentClient({organizationId:f.A,fetchImpl:f.fetchImpl});
    const view=mountSupplies(d.getElementById('root'),{client,synthetic:true,makeKey:randomUUID});await view.ready;
    assert.match(d.body.textContent,/not configured/);
    submit(d,'Configure par level',{parQuantity:'5.125'});
    await until(()=>d.querySelector('[role=status]').textContent.startsWith('Saved.'));
    assert.equal(d.activeElement.id,`supply-${b.id}`);
    submit(d,'Check low stock');await until(()=>findForm(d,'Assign to me'));
    submit(d,'Assign to me');await until(()=>findForm(d,'Complete replenishment'));
    submit(d,'Complete replenishment',{receivedQuantity:'5.125'});
    await until(()=>!findForm(d,'Complete replenishment')&&d.querySelector('[role=status]').textContent.startsWith('Saved.'));
    assert.match(d.body.textContent,/5.125 ml on hand/);
    submit(d,'Correct counted stock',{countedQuantity:'5.001'});
    await until(()=>d.body.textContent.includes('5.001 ml on hand'));
    [...d.querySelectorAll('button')].find(x=>x.textContent==='View audit history').click();
    await until(()=>d.body.textContent.includes('count-corrected'));
    assert.match(d.body.textContent,/-0.124/);
    page.window.eval(axe.source);
    const audit=await page.window.axe.run(d,{rules:{'color-contrast':{enabled:false}}});
    assert.equal(audit.violations.length,0,JSON.stringify(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))));
    view.destroy();assert.equal(d.getElementById('root').textContent,'');
  } finally {page.window.close();await f.close();}
});
test('uncertain completion keeps exact original command/key, visibly locks draft, and confirms original response on retry',async()=>{
  const f=await fixture(),page=dom(),d=page.window.document;
  try {
    const b=await f.newBin();
    await f.service.configure(f.manager,f.A,f.command(b,{parQuantity:'2',expectedPolicyVersion:0}));
    const {task}=await f.service.detect(f.manager,f.A,f.command(b));
    await f.service.assign(f.manager,f.A,f.command(b,{taskId:task.id,expectedTaskVersion:0}));
    let interrupt=true;const seen=[];
    const fetchImpl=async(url,opts)=>{
      const response=await f.fetchImpl(url,opts);
      if(url.endsWith('/complete')){seen.push(JSON.parse(opts.body));if(interrupt){interrupt=false;throw Error('synthetic response lost AFTER COMMIT');}}
      return response;
    };
    const client=createReplenishmentClient({organizationId:f.A,fetchImpl});
    const view=mountSupplies(d.getElementById('root'),{client,makeKey:randomUUID});await view.ready;
    const form=submit(d,'Complete replenishment',{receivedQuantity:'2.125'});
    await until(()=>d.querySelector('[role=status]').textContent.startsWith('Result unknown'));
    assert.equal(form.elements.receivedQuantity.disabled,true);assert.equal(form.elements.receivedQuantity.value,'2.125');
    await view.refresh();
    // Completed task is no longer in active queue, but the pending operation must remain retryable.
    assert.ok(d.querySelector('[data-pending]'),'unknown completed request must not vanish after refetch');
    d.querySelector('[data-pending] button').click();
    await until(()=>d.querySelector('[role=status]').textContent.startsWith('Original saved result confirmed'));
    assert.deepEqual(seen[1],seen[0]);
    assert.equal((await f.owner('SELECT quantity FROM supply_bin_stock WHERE bin_id=$1',[b.id])).rows[0].quantity,'2.125');
  } finally {page.window.close();await f.close();}
});
test('known conflicts preserve editable draft; explicit refresh keeps text and updates expected versions',async()=>{
  const f=await fixture(),page=dom(),d=page.window.document;
  try {
    const b=await f.newBin();
    const client=createReplenishmentClient({organizationId:f.A,fetchImpl:f.fetchImpl});
    const view=mountSupplies(d.getElementById('root'),{client,makeKey:randomUUID});await view.ready;
    await f.stock(b);
    const form=submit(d,'Correct counted stock',{countedQuantity:'3.125',reason:'Synthetic reviewed count'});
    await until(()=>d.querySelector('[role=alert]').textContent.includes('Counts changed'));
    assert.equal(form.elements.countedQuantity.value,'3.125');assert.equal(form.elements.countedQuantity.disabled,false);
    await view.refresh();assert.equal(findForm(d,'Correct counted stock').elements.reason.value,'Synthetic reviewed count');
    submit(d,'Correct counted stock',{countedQuantity:'3.125',reason:'Synthetic reviewed count'});
    await until(()=>d.querySelector('[role=status]').textContent.startsWith('Saved.'));
    assert.match(d.body.textContent,/3.125 ml/);
  }finally{page.window.close();await f.close();}
});
test('save success plus refresh failure stays truthful and blocks new mutation until fresh state arrives',async()=>{
  const f=await fixture(),page=dom(),d=page.window.document;
  try {
    const b=await f.newBin();let broken=false,writes=0;
    const fetchImpl=async(url,opts)=>{
      if(opts.method==='POST'){writes++;const response=await f.fetchImpl(url,opts);broken=true;return response;}
      if(broken)throw Error('Synthetic refresh unavailable');return f.fetchImpl(url,opts);
    };
    const view=mountSupplies(d.getElementById('root'),{client:createReplenishmentClient({organizationId:f.A,fetchImpl}),makeKey:randomUUID});await view.ready;
    const form=submit(d,'Correct counted stock',{countedQuantity:'1'});
    await until(()=>d.querySelector('[role=status]').textContent.startsWith('Saved, but refresh failed'));
    form.dispatchEvent(new d.defaultView.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(writes,1);
    broken=false;await view.refresh();assert.match(d.body.textContent,/1.000 ml on hand/);
  }finally{page.window.close();await f.close();}
});
test('read-only, empty, initial failure and revoked access states expose no writable or stale unauthorized records',async()=>{
  const f=await fixture(),page=dom(),d=page.window.document;
  try {
    let who='viewer',offline=false;
    const fetchImpl=(url,opts)=>{if(offline)throw Error('Synthetic offline');return f.fetchImpl(url,{...opts,headers:{...opts.headers,'x-sv010-test-user':who}});};
    const view=mountSupplies(d.getElementById('root'),{client:createReplenishmentClient({organizationId:f.A,fetchImpl}),makeKey:randomUUID});await view.ready;
    assert.match(d.body.textContent,/No authorized supply bins/);assert.equal(d.querySelectorAll('form').length,0);
    await f.newBin();await view.refresh();assert.match(d.body.textContent,/Synthetic test supply/);assert.equal(d.querySelectorAll('form').length,0);
    who='outsider';await view.refresh();assert.doesNotMatch(d.body.textContent,/Synthetic test supply/);
    offline=true;await view.refresh();assert.match(d.body.textContent,/Refresh failed/);
  }finally{page.window.close();await f.close();}
});
test('client rejects invalid organization and treats unreadable/5xx mutation responses as uncertain',async()=>{
  assert.throws(()=>createReplenishmentClient({organizationId:'../../escape'}));
  const org=randomUUID();
  for(const fetchImpl of [async()=>new Response('invalid',{status:201}),async()=>new Response('{"error":"internal_error"}',{status:500})]) {
    const c=createReplenishmentClient({organizationId:org,fetchImpl});
    await assert.rejects(c.command('complete',{}),e=>e.uncertain===true);
  }
});
