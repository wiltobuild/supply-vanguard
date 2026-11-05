import test from 'node:test';
import assert from 'node:assert/strict';
import {SCHEMA_VERSION,TRANSITIONS,STATUSES,canTransition,validateEquipmentRecord,validateObservation,validateAdminCommand,applyAdminCommand,applyObservation,freshness} from '../packages/domain/contracts.js';
import {roomIds} from '../packages/domain/seed.js';
const T0='2026-11-05T10:00:00.000Z',T1='2026-11-05T10:20:00.000Z',T2='2026-11-05T10:40:00.000Z';
const item=(o={})=>({schemaVersion:SCHEMA_VERSION,id:'EQ-001',name:'Transport incubator',modelKind:'incubator',locationId:'equipment-store',status:'available',version:0,lastVerified:{locationId:'equipment-store',observedAt:T0,source:'manual-check-in'},lastAdminEditAt:null,provenance:'synthetic-seed',...o});
const obs=(o={})=>({schemaVersion:SCHEMA_VERSION,equipmentId:'EQ-001',locationId:'room-101',observedAt:T1,receivedAt:T1,source:'barcode',actor:'operator',idempotencyKey:'k1',...o});
const cmd=(o={})=>({schemaVersion:SCHEMA_VERSION,equipmentId:'EQ-001',expectedVersion:0,actor:'operator',idempotencyKey:'c1',status:'cleaning',...o});
test('valid records pass and invalid fields are rejected',()=>{
 assert.ok(validateEquipmentRecord(item(),roomIds));
 assert.ok(validateEquipmentRecord(item({lastVerified:null}),roomIds));
 for(const bad of [{status:'broken'},{locationId:'nowhere'},{version:-1},{version:1.5},{id:''},{extra:1},{schemaVersion:2},{lastAdminEditAt:'yesterday'},{lastVerified:{locationId:'room-101',observedAt:'x',source:'barcode'}},{lastVerified:{locationId:'room-101',observedAt:T0,source:'guess'}},{note:'x'.repeat(501)}])assert.throws(()=>validateEquipmentRecord(item(bad),roomIds),undefined,JSON.stringify(bad));
 assert.throws(()=>validateEquipmentRecord(null,roomIds));
});
test('observations and commands reject bad fields',()=>{
 assert.ok(validateObservation(obs(),roomIds));assert.ok(validateAdminCommand(cmd()));
 for(const bad of [{source:'guess'},{locationId:'nowhere'},{observedAt:'soon'},{idempotencyKey:''},{extra:true}])assert.throws(()=>validateObservation(obs(bad),roomIds));
 for(const bad of [{status:'broken'},{expectedVersion:-1},{extra:true},{idempotencyKey:undefined}])assert.throws(()=>validateAdminCommand(cmd(bad)));
 assert.throws(()=>validateAdminCommand(cmd({status:undefined})));
});
test('transitions: every listed target is a real status and retired is terminal',()=>{
 for(const [from,tos] of Object.entries(TRANSITIONS)){assert.ok(STATUSES.includes(from));for(const to of tos)assert.ok(STATUSES.includes(to));}
 assert.equal(canTransition('available','in-use'),true);assert.equal(canTransition('in-use','available'),false);assert.equal(canTransition('retired','available'),false);assert.equal(canTransition('toString','available'),false);
 assert.throws(()=>applyAdminCommand(item({status:'in-use'}),cmd({status:'available'})),/not allowed/);
 assert.throws(()=>applyAdminCommand(item({status:'retired'}),cmd({status:'available'})));
});
test('admin edits do not refresh location confidence',()=>{
 const before=item(),r=applyAdminCommand(before,cmd(),{now:T2});
 assert.equal(r.equipment.status,'cleaning');assert.equal(r.equipment.version,1);assert.equal(r.equipment.lastAdminEditAt,T2);
 assert.deepEqual(r.equipment.lastVerified,before.lastVerified);assert.equal(r.equipment.locationId,before.locationId);
 assert.equal(r.event.kind,'admin');assert.equal(r.event.idempotencyKey,'c1');
 assert.equal(freshness(r.equipment,Date.parse(T2)),'stale');
});
test('stale writes and cross-item commands are rejected',()=>{
 const r=applyAdminCommand(item(),cmd(),{now:T2});
 assert.throws(()=>applyAdminCommand(r.equipment,cmd({status:'available'}),{now:T2}),/Conflict/);
 assert.throws(()=>applyAdminCommand(item(),cmd({equipmentId:'EQ-002'})),/different item/);
});
test('observations update location but not status, and cannot move an item backward',()=>{
 const base=item(),r=applyObservation(base,obs(),roomIds);
 assert.equal(r.applied,true);assert.equal(r.equipment.locationId,'room-101');assert.equal(r.equipment.lastVerified.observedAt,T1);
 assert.equal(r.equipment.status,base.status);assert.equal(r.equipment.version,base.version);assert.equal(r.equipment.lastAdminEditAt,null);
 const late=applyObservation(r.equipment,obs({locationId:'room-103',observedAt:T0,receivedAt:T2,idempotencyKey:'k2'}),roomIds);
 assert.equal(late.applied,false);assert.equal(late.equipment.locationId,'room-101');
 const replay=applyObservation(r.equipment,obs(),roomIds);assert.equal(replay.applied,false);
 assert.throws(()=>applyObservation(base,obs({observedAt:T2,receivedAt:T1}),roomIds),/after receivedAt/);
 assert.equal(applyObservation(item({lastVerified:null}),obs(),roomIds).applied,true);
});
test('freshness comes only from the last observation',()=>{
 const t=Date.parse(T0);
 assert.equal(freshness(item({lastVerified:null}),t),'unknown');
 assert.equal(freshness(item(),t+60e3),'fresh');assert.equal(freshness(item(),t+10*60e3),'aging');assert.equal(freshness(item(),t+31*60e3),'stale');
});
