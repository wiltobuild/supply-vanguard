import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as config from './config.js';

// Small DOM fixture executes the real list-only entry point. Detaching a focused
// descendant resets focus to BODY, matching the regression reported in browsers.
function loadList(){
 const document={};
 class Element{
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.value='';this.hidden=false;this.scrollTop=0;}
  append(...nodes){this.children.push(...nodes);}
  contains(node){return this===node||this.children.some(child=>child.contains(node));}
  replaceChildren(...nodes){if(this.children.some(child=>child.contains(document.activeElement)))document.activeElement=document.body;this.children=nodes;}
  setAttribute(key,value){this.attributes[key]=value;}
  getAttribute(key){return this.attributes[key];}
  querySelectorAll(tag){return this.children.flatMap(child=>[...(child.tagName===tag.toUpperCase()?[child]:[]),...child.querySelectorAll(tag)]);}
  addEventListener(){}
  focus(){document.activeElement=this;}
  click(){this.onclick?.();}
 }
 document.body=new Element('body');document.activeElement=document.body;
 const ids=Object.fromEntries(['kind','selection','selected-name','selected-detail','count','search','equipment-list','show-type','room-views','scene-state','instructions','walk-controls'].map(id=>[id,new Element(id==='kind'?'select':id==='show-type'?'button':'div')]));
 ids.kind.value='all';document.body.append(...Object.values(ids));
 document.getElementById=id=>ids[id];document.createElement=tag=>new Element(tag);document.querySelectorAll=()=>[];
 const source=readFileSync(new URL('app.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'');
 vm.runInNewContext(source,{...config,document,location:{search:'?view=list'},URLSearchParams,console});
 return {document,ids};
}

test('activating focused equipment preserves its button, focus and list scroll',()=>{
 const {document,ids}=loadList(),before=ids['equipment-list'].querySelectorAll('button');
 const pump=before.find(button=>button.dataset.equipmentId==='picu-room-a1-infusion');
 ids['equipment-list'].scrollTop=120;pump.focus();pump.click();
 assert.equal(document.activeElement,pump);
 assert.deepEqual(ids['equipment-list'].querySelectorAll('button'),before,'selection must not replace list controls');
 assert.equal(ids['equipment-list'].scrollTop,120);
 assert.equal(pump.getAttribute('aria-pressed'),'true');
 assert.equal(ids['selected-name'].textContent,'IV pump');
 const next=before[before.indexOf(pump)+1];next.focus();next.click();
 assert.equal(document.activeElement,next);assert.equal(next.getAttribute('aria-pressed'),'true');assert.equal(pump.getAttribute('aria-pressed'),'false');
});

test('show-type transfers focus from the hidden selection action to the type filter',()=>{
 const {document,ids}=loadList();
 ids['equipment-list'].querySelectorAll('button').find(button=>button.dataset.equipmentId==='picu-room-a1-infusion').click();
 ids['show-type'].focus();ids['show-type'].click();
 assert.equal(document.activeElement,ids.kind);assert.equal(ids.kind.value,'infusion');
 assert.equal(ids['equipment-list'].querySelectorAll('button').length,10);
 assert.equal(ids.selection.hidden,true);
});

test('equipment workspace link targets the supported equipment route',()=>{
 const html=readFileSync(new URL('index.html',import.meta.url),'utf8');
 assert.match(html,/<a href="\/#\/equipment">Equipment workspace/);
 assert.doesNotMatch(html,/href="\/#ward"/);
});
