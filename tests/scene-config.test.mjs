import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {MODEL_REGISTRY,slotPosition,planPlacements,diffPlacements,validateSceneConfig} from '../packages/scene/viewer/config.js';
import {ROOMS,INITIAL_LOCATIONS} from '../packages/scene/viewer/data.js';
import {LIMITS} from '../packages/scene/viewer/nav.js';
import {seedEquipment} from '../packages/domain/seed.js';
const viewer=new URL('../packages/scene/viewer/',import.meta.url);
test('shipped rooms, locations and model registry validate',()=>{
 const summary=validateSceneConfig({locations:INITIAL_LOCATIONS});
 assert.deepEqual(summary,{rooms:10,locations:INITIAL_LOCATIONS.length,models:Object.keys(MODEL_REGISTRY).length});
 for(const m of Object.values(MODEL_REGISTRY))assert.ok(existsSync(new URL(m.glb,viewer)),m.glb);
 const shipped=JSON.parse(readFileSync(new URL('assets/locations.json',viewer),'utf8'));
 assert.deepEqual(shipped.locations.map(l=>l.id),INITIAL_LOCATIONS.map(l=>l.id));
});
test('invalid configuration is rejected',()=>{
 const bad=(o,msg)=>assert.throws(()=>validateSceneConfig(o),msg);
 bad({rooms:[...ROOMS,ROOMS[0]]},/Duplicate room/);
 bad({rooms:[{...ROOMS[0],x:NaN}]},/finite meter/);
 bad({rooms:[{...ROOMS[0],x:50}]},/outside the ward bounds/);
 bad({rooms:[{...ROOMS[0],side:0}]},/side/);
 bad({locations:[{...INITIAL_LOCATIONS[0],roomId:'nowhere'}]},/unknown room/);
 bad({locations:[INITIAL_LOCATIONS[0],INITIAL_LOCATIONS[0]]},/Duplicate location/);
 bad({locations:[{...INITIAL_LOCATIONS[0],position:[0,0]}]},/3-number/);
 bad({locations:[{...INITIAL_LOCATIONS[0],position:[99,1,0]}]},/outside the ward bounds/);
 bad({registry:{teleporter:{glb:'assets/incubator.glb'}}},/not a known asset type/);
 bad({registry:{incubator:{glb:'../../etc/passwd'}}},/assets\/\*\.glb/);
});
test('placements use stable IDs, meter coordinates inside the ward, and the original slot layout',()=>{
 const plan=planPlacements(seedEquipment());
 assert.equal(plan.size,8);
 for(const [id,p] of plan){assert.equal(p.id,id);assert.ok(p.position[0]>=LIMITS.minX&&p.position[0]<=LIMITS.maxX&&p.position[2]>=LIMITS.minZ&&p.position[2]<=LIMITS.maxZ,id);assert.equal(p.position[1],0);}
 const store=ROOMS.find(r=>r.id==='equipment-store');
 assert.deepEqual(plan.get('EQ-001').position,[store.x-1,0,store.z+store.side*.6]);
 assert.deepEqual(plan.get('EQ-003').position,slotPosition(store,1));
 assert.throws(()=>planPlacements([{id:'X',modelKind:'teleporter',roomId:'room-101'}]),/Unknown model/);
 assert.throws(()=>planPlacements([...seedEquipment(),seedEquipment()[0]]),/Duplicate/);
 assert.equal(planPlacements([{id:'X',modelKind:'incubator',roomId:'nowhere'}]).size,0);
});
test('a move is reported as a move, so the existing mesh is reused',()=>{
 const items=seedEquipment(),before=planPlacements(items);
 const moved=items.map(i=>i.id==='EQ-001'?{...i,roomId:'room-101'}:i),after=planPlacements(moved,undefined,undefined,before);
 assert.deepEqual(diffPlacements(before,after),{added:[],moved:['EQ-001'],removed:[],retyped:[]});
 assert.equal(after.get('EQ-001').id,'EQ-001');
 assert.deepEqual(diffPlacements(before,before),{added:[],moved:[],removed:[],retyped:[]});
 assert.deepEqual(diffPlacements(before,planPlacements(items.slice(1))).removed,['EQ-001']);
 assert.deepEqual(diffPlacements(planPlacements(items.slice(1)),before).added,['EQ-001']);
 assert.deepEqual(diffPlacements(before,planPlacements(items.map(i=>i.id==='EQ-001'?{...i,modelKind:'warmer'}:i))).retyped,['EQ-001']);
});
test('items that stay in their room keep their slot when others leave or arrive',()=>{
 const items=seedEquipment(),before=planPlacements(items);
 const without=planPlacements(items.slice(1),undefined,undefined,before);
 assert.deepEqual(diffPlacements(before,without),{added:[],moved:[],removed:['EQ-001'],retyped:[]});
 const back=planPlacements(items,undefined,undefined,without);
 assert.deepEqual(back.get('EQ-003').position,before.get('EQ-003').position);
 assert.deepEqual(back.get('EQ-001').position,before.get('EQ-001').position);
});
