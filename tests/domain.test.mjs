import test from 'node:test';
import assert from 'node:assert/strict';
import {change,ready} from '../tools/board-domain.mjs';
import {updateEquipment,isStale} from '../packages/domain/equipment.js';
import {seedEquipment,roomIds} from '../packages/domain/seed.js';
const board=()=>({revision:0,history:[],tasks:[{id:'SV-001',status:'ready',dependsOn:[],claim:null},{id:'SV-002',status:'ready',dependsOn:['SV-001'],claim:null}]});
test('claim exclusion, lease expiry and dependency gates',()=>{const b=board(),opts={command:'claim',id:'SV-001',agent:'a',owner:'wil',leaseId:'one',now:1000};const claimed=change(b,opts);assert.throws(()=>change(claimed,{...opts,agent:'b',leaseId:'two'}));assert.equal(ready(claimed.tasks[1],claimed,1000),false);assert.throws(()=>change(claimed,{command:'heartbeat',id:'SV-001',agent:'a',leaseId:'wrong',now:2000}));assert.equal(change(claimed,{...opts,agent:'b',leaseId:'two',now:8000000}).tasks[0].claim.agent,'b');});
function submittedBoard(){
 let b=change(board(),{command:'claim',id:'SV-001',agent:'a',owner:'wil',leaseId:'one',now:1000});
 return change(b,{command:'submit',id:'SV-001',agent:'a',leaseId:'one',now:2000,pr:'https://github.com/wiltobuild/supply-vanguard/pull/1'});
}
test('submitters and other agents can complete merged tasks without a separate review',()=>{
 for(const agent of ['a','b']){
  const submitted=submittedBoard(),evidence={mergedAt:'verified-by-cli'};
  assert.equal(ready(submitted.tasks[0],submitted,99999999),false);
  const completed=change(submitted,{command:'complete',id:'SV-001',agent,evidence});
  assert.equal(completed.tasks[0].status,'done');
  assert.equal(completed.tasks[0].submittedBy,'a');
  assert.equal(completed.tasks[0].completedBy,agent);
  assert.equal(completed.tasks[0].reviewedBy,undefined);
  assert.deepEqual(completed.tasks[0].evidence,evidence);
  assert.equal(ready(completed.tasks[1],completed,10000),true);
  assert.equal(submitted.tasks[0].status,'review');
 }
});
test('completion still requires submission, an agent and merged PR evidence',()=>{
 const submitted=submittedBoard();
 assert.throws(()=>change(board(),{command:'complete',id:'SV-001',agent:'a',evidence:{}}),/Only a submitted task/);
 assert.throws(()=>change(submitted,{command:'complete',id:'SV-001',evidence:{}}),/requires an agent/);
 assert.throws(()=>change(submitted,{command:'complete',id:'SV-001',agent:'a'}),/Merged PR evidence required/);
 assert.equal(ready(submitted.tasks[1],submitted,10000),false);
});
test('submitters and other agents can return submitted work with a reason',()=>{
 for(const agent of ['a','b']){
  const submitted=submittedBoard();
  const reworked=change(submitted,{command:'rework',id:'SV-001',agent,reason:'Fix a failing test'});
  assert.equal(reworked.tasks[0].status,'ready');
  assert.equal(reworked.tasks[0].reviewNote,'Fix a failing test');
  assert.equal(reworked.tasks[0].claim,null);
  assert.equal(ready(reworked.tasks[1],reworked,10000),false);
 }
 assert.throws(()=>change(submittedBoard(),{command:'rework',id:'SV-001',agent:'a'}),/Agent and reason required/);
 assert.throws(()=>change(submittedBoard(),{command:'rework',id:'SV-001',reason:'Fix'}),/Agent and reason required/);
 assert.throws(()=>change(board(),{command:'rework',id:'SV-001',agent:'a',reason:'Fix'}),/Only a submitted task/);
});
test('equipment updates preserve identity and reject stale writes and invalid rooms',()=>{const item=seedEquipment()[0],opts={expectedVersion:0,actor:'operator',roomIds};const r=updateEquipment(item,{roomId:'room-101',status:'in-use'},opts);assert.equal(r.equipment.id,item.id);assert.equal(r.event.before.roomId,'equipment-store');assert.equal(r.equipment.version,1);assert.throws(()=>updateEquipment(r.equipment,{status:'available'},opts));assert.throws(()=>updateEquipment(item,{roomId:'unknown'},opts));assert.equal(isStale(item),true);assert.throws(()=>updateEquipment({...item,status:'retired'},{status:'available'},opts));});
