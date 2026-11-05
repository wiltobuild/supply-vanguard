import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Small DOM fixture for the actual list-only app, with the browser's focus-on-removal
// behavior. Real Tab/Enter/Space behavior is also verified in-browser (VERIFICATION.md).
function fixture() {
 const document={activeElement:null};
 class Element {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.dataset={};this.attributes={};this.listeners={};this.value='';this.scrollTop=0;this.classList={add(){}};this._text='';}
  contains(node){return node===this||this.children.some(child=>child.contains(node));}
  append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
  replaceChildren(...nodes){if(this.children.some(child=>child.contains(document.activeElement)))document.activeElement=document.body;for(const child of this.children)child.parentElement=null;this.children=[];this._text='';this.append(...nodes);}
  set textContent(value){this.replaceChildren();this._text=String(value);}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  addEventListener(type,handler){this.listeners[type]=handler;}
  focus(){document.activeElement=this;}
 }
 document.body=new Element('body');document.activeElement=document.body;
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,new Element('div')]));
 for(const node of nodes.values())document.body.append(node);
 document.getElementById=id=>nodes.get(id);document.createElement=tag=>new Element(tag);
 nodes.get('equipment-kind').value='all';
 return {document,nodes};
}

test('selecting a focused filtered row preserves focus, node identity, scroll and next-row context in graphics-free mode',async()=>{
 const {document,nodes}=fixture(),oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),oldLocation=Object.getOwnPropertyDescriptor(globalThis,'location'),oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
 const events={},history={state:{otherFeature:'retained'},replaceState(value){this.state=value;}};Object.defineProperty(globalThis,'window',{value:{history,addEventListener:(type,handler)=>events[type]=handler},configurable:true});
 Object.defineProperty(globalThis,'document',{value:document,configurable:true});Object.defineProperty(globalThis,'location',{value:{search:'?view=list'},configurable:true});
 try{
  await import('../app.js?keyboard-regression');
  const search=nodes.get('equipment-search'),list=nodes.get('equipment-list');
  search.value='bay A1';search.listeners.input();
  const [pump,monitor,cart]=list.children;assert.equal(list.children.length,3);list.scrollTop=37;pump.focus();
  pump.onclick();
  assert.equal(document.activeElement,pump,'selection must not detach the focused result');
  assert.deepEqual(list.children,[pump,monitor,cart],'selection must keep the existing result nodes');
  assert.equal(pump.getAttribute('aria-pressed'),'true');assert.equal(monitor.getAttribute('aria-pressed'),'false');
  assert.equal(search.value,'bay A1');assert.equal(list.scrollTop,37);assert.match(nodes.get('selection').textContent,/pcu-bay-a1-iv/);
  pump.onclick();assert.equal(document.activeElement,pump,'repeated keyboard activation stays on the result');
  monitor.focus();monitor.onclick();assert.equal(document.activeElement,monitor);assert.equal(pump.getAttribute('aria-pressed'),'false');assert.equal(monitor.getAttribute('aria-pressed'),'true');assert.match(nodes.get('selection').textContent,/pcu-bay-a1-monitor/);
  assert.equal(nodes.get('scene').children.length,0,'list mode must not create a graphics canvas');
  events.pageshow({persisted:true});await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(document.activeElement,monitor,'unchanged history results preserve focus');assert.deepEqual(list.children,[pump,monitor,cart]);
  // Simulate browser form restoration after pageshow, without input/change events.
  history.state=null;
  events.pageshow({persisted:false});search.value='';nodes.get('equipment-kind').value='infusion';
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(list.children.length,9);assert.ok(list.children.every(row=>row.dataset.equipmentId.endsWith('-iv')));assert.match(nodes.get('result-count').textContent,/^9 of 26/);
  // A later traversal restores both controls; the intersection yields one monitor.
  events.pageshow({persisted:true});search.value='bay A1';nodes.get('equipment-kind').value='monitor';
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(list.children.map(row=>row.dataset.equipmentId),['pcu-bay-a1-monitor']);assert.match(nodes.get('result-count').textContent,/^1 of 26/);
  events.pageshow({persisted:true});search.value='no match';
  await new Promise(resolve=>setTimeout(resolve,0));assert.match(nodes.get('result-count').textContent,/^0 of 26/);assert.match(list.textContent,/No matching/);
  // Own history state preserves both controls even if native restoration clears text.
  history.state={otherFeature:'retained'};search.value='A1';nodes.get('equipment-kind').value='monitor';search.listeners.input();
  assert.deepEqual(history.state,{otherFeature:'retained',pcuFilters:{query:'A1',kind:'monitor'}});
  search.value='';nodes.get('equipment-kind').value='all';events.pageshow({persisted:false});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(search.value,'A1');assert.equal(nodes.get('equipment-kind').value,'monitor');assert.deepEqual(list.children.map(row=>row.dataset.equipmentId),['pcu-bay-a1-monitor']);assert.match(nodes.get('result-count').textContent,/^1 of 26/);
 }finally{
  if(oldDocument)Object.defineProperty(globalThis,'document',oldDocument);else delete globalThis.document;
  if(oldLocation)Object.defineProperty(globalThis,'location',oldLocation);else delete globalThis.location;
  if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else delete globalThis.window;
 }
});
