// SV-010 review follow-up: deferred old-session work after destroy() and replacement mounting on the same root.
// Controlled, synthetic collaborators only: a real client over a fake fetch, jsdom, no SQL fixture, server, network or provisioning.
//   node --test services/api/replenishment/tests/lifecycle.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createReplenishmentClient} from '../../../../apps/web/supplies/client.mjs';
import {mountSupplies} from '../../../../apps/web/supplies/view.mjs';

const organizationId='00000000-0000-4000-8000-000000000001';
const bin={id:organizationId,name:'Synthetic supply',code:'SYN-1',unit:'each',quantity:'1.000',stock_version:1,par_quantity:'2.000',par_version:1,low_par:true};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const settle=async()=>{for(let n=0;n<8;n++)await tick();};
async function until(fn){for(let n=0;n<200;n++){if(fn())return;await tick();}assert.fail('Controlled UI did not settle');}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

// One synthetic "session": its own client, its own fake server state, and gates it can hold a bin list behind.
function session(page,name){
  const state={mode:'allowed',binLists:0,holdFrom:Infinity,gate:deferred(),commands:[]};
  const client=createReplenishmentClient({organizationId,fetchImpl:async(url,options)=>{
    if(options.method==='POST'){
      state.commands.push(JSON.parse(options.body));
      if(state.mode==='lost')throw Error('Synthetic uncertain transport');
      if(typeof state.mode==='number')return new Response('<html>denied</html>',{status:state.mode});
      return new Response(JSON.stringify({replayed:false}),{status:200});
    }
    if(url.endsWith('/bins')){
      state.binLists++;
      if(state.binLists>=state.holdFrom)await state.gate.promise;
      return new Response(JSON.stringify({items:[bin],nextCursor:null,canWrite:true}),{status:200});
    }
    return new Response(JSON.stringify({items:[],nextCursor:null}),{status:200});
  }});
  let keys=0;
  const root=page.window.document.getElementById('root');
  return {name,state,client,mount:()=>mountSupplies(root,{client,makeKey:()=>`${name}-key-${++keys}`}),
    holdNextBinList(){state.holdFrom=state.binLists+1;state.gate=deferred();},release(){state.gate.resolve();}};
}
const newPage=()=>new JSDOM('<!doctype html><html lang="en"><title>Synthetic lifecycle test</title><main id="root"></main></html>',{url:'https://synthetic.invalid/'});
const refreshButton=root=>[...root.querySelectorAll('button')].find(b=>b.textContent==='Refresh counts and queue');
function submitCorrection(page,quantity='3'){
  const form=[...page.window.document.querySelectorAll('form')].find(f=>f.getAttribute('aria-label').startsWith('Correct counted stock:'));
  assert.ok(form);form.parentElement.open=true;
  for(const [name,value] of Object.entries({countedQuantity:quantity,reason:'Synthetic reason'})){
    form.elements.namedItem(name).value=value;form.elements.namedItem(name).dispatchEvent(new page.window.Event('input',{bubbles:true}));
  }
  form.dispatchEvent(new page.window.Event('submit',{bubbles:true,cancelable:true}));
}
const describe=el=>`${el.tagName}${el.id?'#'+el.id:''}`;

// A write succeeds, its refresh is still in flight, the old session is destroyed and a new one mounted on the same root.
// When the old refresh settles, the old handler must not touch the document: no focus move into the new session.
test('a save finishing after destroy and replacement mount cannot take focus from the new session',async()=>{
  const page=newPage(),doc=page.window.document,root=doc.getElementById('root');
  const A=session(page,'old'),B=session(page,'new');
  try {
    const oldView=A.mount();await oldView.ready;
    A.holdNextBinList();                                   // the refresh after the save will wait
    submitCorrection(page);
    await until(()=>A.state.commands.length===1&&A.state.binLists===2);   // saved; the old handler now awaits its refresh
    oldView.destroy();
    const newView=B.mount();await newView.ready;
    const newRefresh=refreshButton(root);newRefresh.focus();
    assert.equal(doc.activeElement,newRefresh);
    const before=root.textContent;
    A.release();await settle();                            // the old refresh completes now
    assert.equal(describe(doc.activeElement),describe(newRefresh),'focus stays on the new session\'s control');
    assert.equal(doc.activeElement,newRefresh);
    assert.equal(root.textContent,before,'the old session wrote nothing into the new session');
    assert.equal(B.state.commands.length,0);
    newView.destroy();
  } finally {page.window.close();}
});

test('a retried save finishing after destroy and replacement mount cannot take focus from the new session',async()=>{
  const page=newPage(),doc=page.window.document,root=doc.getElementById('root');
  const A=session(page,'old'),B=session(page,'new');
  try {
    const oldView=A.mount();await oldView.ready;
    A.state.mode='lost';submitCorrection(page);
    await until(()=>root.querySelector('[data-pending]'));            // an unconfirmed request is waiting for a retry
    A.state.mode='allowed';A.holdNextBinList();
    root.querySelector('[data-pending] button').click();
    await until(()=>A.state.commands.length===2&&A.state.binLists===2);
    oldView.destroy();
    const newView=B.mount();await newView.ready;
    const newRefresh=refreshButton(root);newRefresh.focus();
    const before=root.textContent;
    A.release();await settle();
    assert.equal(doc.activeElement,newRefresh,'focus stays on the new session\'s control');
    assert.equal(root.textContent,before);
    newView.destroy();
  } finally {page.window.close();}
});

// The host may mount the new session before it destroys the old one. Destroying the old one must not erase the new one.
test('destroying an old session after a newer one mounted on the same root leaves the newer one intact and working',async()=>{
  const page=newPage(),doc=page.window.document,root=doc.getElementById('root');
  const A=session(page,'old'),B=session(page,'new');
  try {
    const oldView=A.mount();await oldView.ready;
    const newView=B.mount();await newView.ready;
    const before=root.textContent;
    assert.match(before,/Synthetic supply/);
    oldView.destroy();
    assert.equal(root.textContent,before,'the newer session\'s content survives the old destroy()');
    assert.ok(root.classList.contains('supplies'),'and its root styling');
    assert.ok(refreshButton(root)&&root.querySelector('form'),'its controls are still there');
    oldView.destroy();                                    // a second destroy is harmless too
    assert.equal(root.textContent,before);
    // The newer session still works: its own refresh runs and updates its own status.
    const lists=B.state.binLists;
    refreshButton(root).click();await until(()=>B.state.binLists===lists+1);await settle();
    assert.match(root.querySelector('[role=status]').textContent,/^Loaded 1 bins/);
    // Destroying the session that owns the root still clears it completely.
    newView.destroy();
    assert.equal(root.textContent,'');assert.equal(root.children.length,0);assert.ok(!root.classList.contains('supplies'));
  } finally {page.window.close();}
});

// Guards that already held and must keep holding: old state cannot reach the new session.
test('an old session\'s draft, pending request and late result never reach the new session',async()=>{
  const page=newPage(),doc=page.window.document,root=doc.getElementById('root');
  const A=session(page,'old'),B=session(page,'new');
  try {
    const oldView=A.mount();await oldView.ready;
    A.state.mode='lost';submitCorrection(page,'9');
    await until(()=>root.querySelector('[data-pending]'));
    const oldRetry=root.querySelector('[data-pending] button');
    oldView.destroy();
    const newView=B.mount();await newView.ready;
    assert.equal(root.querySelectorAll('[data-pending]').length,0,'no pending request carried over');
    assert.ok([...root.querySelectorAll('input[name=reason]')].every(n=>n.value===''),'no old draft restored');
    assert.ok([...root.querySelectorAll('input[name=countedQuantity]')].every(n=>n.value===''));
    const before=root.textContent;
    A.state.mode=403;oldRetry.click();await settle();                  // the old, detached retry button is clicked late and is refused
    assert.equal(root.textContent,before,'a late 403 on the old session does not clear or alter the new one');
    assert.equal(B.state.commands.length,0,'the new session sent nothing');
    assert.ok(root.querySelector('form')&&root.querySelector('article'),'the new session still has its records and forms');
    newView.destroy();
  } finally {page.window.close();}
});

// The host replaces the session by mounting over it and never calls destroy() on the old one. The old session is not disposed, so its
// handler runs to the end. It may only look inside its own nodes: it must not find, and focus, the new session's heading.
test('an old session that was replaced without destroy() still cannot take focus from the new session',async()=>{
  const page=newPage(),doc=page.window.document,root=doc.getElementById('root');
  const A=session(page,'old'),B=session(page,'new');
  try {
    const oldView=A.mount();await oldView.ready;
    A.holdNextBinList();submitCorrection(page);
    await until(()=>A.state.commands.length===1&&A.state.binLists===2);
    const newView=B.mount();await newView.ready;                    // mounted over the old one; the old destroy() is never called
    const newRefresh=refreshButton(root);newRefresh.focus();
    const before=root.textContent;
    A.release();await settle();
    assert.equal(doc.activeElement,newRefresh,'focus stays on the new session\'s control');
    assert.equal(root.textContent,before);assert.equal(B.state.commands.length,0);
    newView.destroy();oldView.destroy();                            // late, reversed destroy of the old one is harmless
    assert.equal(root.textContent,'');
  } finally {page.window.close();}
});

test('a retried save in an old session that was replaced without destroy() cannot take focus from the new session',async()=>{
  const page=newPage(),doc=page.window.document,root=doc.getElementById('root');
  const A=session(page,'old'),B=session(page,'new');
  try {
    const oldView=A.mount();await oldView.ready;
    A.state.mode='lost';submitCorrection(page);
    await until(()=>root.querySelector('[data-pending]'));
    A.state.mode='allowed';A.holdNextBinList();
    root.querySelector('[data-pending] button').click();
    await until(()=>A.state.commands.length===2&&A.state.binLists===2);
    const newView=B.mount();await newView.ready;                    // mounted over the old one; destroy() is never called on it
    const newRefresh=refreshButton(root);newRefresh.focus();
    const before=root.textContent;
    A.release();await settle();
    assert.equal(doc.activeElement,newRefresh,'focus stays on the new session\'s control');
    assert.equal(root.textContent,before);
    newView.destroy();
  } finally {page.window.close();}
});
