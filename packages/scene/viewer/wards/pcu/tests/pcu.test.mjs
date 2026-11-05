import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {WARD,ROOMS,LOCATIONS,EQUIPMENT,MODEL_LABELS,LIMITS,isWalkable,moveWithinBounds,filterEquipment} from '../config.js';
import {createPcuWard} from '../ward.js';
const ward=createPcuWard();
test('separate stable identities map every synthetic item to a bounded, inferred PCU location',()=>{
 assert.equal(WARD.units,'meters');assert.equal(WARD.up,'Y');assert.equal(ROOMS.length,8);
 const ids=[...LOCATIONS,...EQUIPMENT].map(v=>v.id);assert.equal(new Set(ids).size,ids.length);assert.ok(ids.every(id=>id.startsWith('pcu-')));
 for(const item of EQUIPMENT){assert.ok(LOCATIONS.some(r=>r.id===item.locationId));assert.ok(Object.hasOwn(MODEL_LABELS,item.kind));assert.ok(item.x>LIMITS.minX&&item.x<LIMITS.maxX&&item.z>LIMITS.minZ&&item.z<LIMITS.maxZ);assert.ok(ward.equipmentObjects.has(item.id));}
 assert.ok(LOCATIONS.every(r=>r.confidence==='inferred'));assert.equal(ward.root.userData.architecturalAccuracyClaimed,false);
});
test('existing procedural models and section geometry have finite bounds',()=>{
 const kinds=new Set();for(const asset of ward.assetInstances){kinds.add(asset.userData.assetType);const box=new THREE.Box3().setFromObject(asset);assert.ok(!box.isEmpty());assert.ok([...box.min,...box.max].every(Number.isFinite));}
 assert.ok(kinds.has('infusion')&&kinds.has('monitor')&&kinds.has('recliner')&&kinds.has('workstation'));
 const bounds=new THREE.Box3().setFromObject(ward.root);assert.ok([...bounds.min,...bounds.max].every(Number.isFinite));assert.ok(bounds.max.x-bounds.min.x<34);assert.ok(bounds.max.z-bounds.min.z<20);
});
test('every visit point is walkable and connected to the corridor through its doorway',()=>{
 for(const room of LOCATIONS){assert.ok(isWalkable(...room.approach,ward.obstacles),room.id);for(let x=-13.5;x<room.doorX;x+=.1)assert.ok(isWalkable(x,0,ward.obstacles),`hall ${room.id}`);for(let z=0;Math.abs(z)<Math.abs(room.approach[1]);z+=room.side*.1)assert.ok(isWalkable(room.doorX,z,ward.obstacles),`door ${room.id}`);}
});
test('walking cannot escape bounds, pass walls or tunnel during long movement',()=>{
 assert.equal(isWalkable(NaN,0,ward.obstacles),false);assert.equal(isWalkable(50,0,ward.obstacles),false);
 const obstacles=[{x:0,z:0,w:.12,d:10}];const result=moveWithinBounds([-1,0],5,0,obstacles);assert.ok(result[0]<-.28);assert.ok(isWalkable(...result,obstacles));
 assert.ok(moveWithinBounds([15,0],10,0,ward.obstacles)[0]<15.57);
});
test('search finds each type across rooms without treating synthetic examples as stock',()=>{
 assert.equal(filterEquipment('IV pump').length,9);assert.equal(filterEquipment('bay A1').length,3);assert.equal(filterEquipment('','monitor').length,8);assert.equal(filterEquipment('not-a-room').length,0);
 assert.ok(EQUIPMENT.every(e=>e.provenance.includes('Synthetic')&&!Object.hasOwn(e,'available')));
});
test('standalone page retains real NICU/workspace return paths and an explicit no-WebGL list',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8'),app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 assert.match(html,/href="\/ward\/"/);assert.match(html,/href="\/#\/equipment"/);assert.match(html,/href="\/"/);assert.match(html,/href="\?view=list"/);assert.doesNotMatch(html,/href="[^\"]*picu/);
 assert.match(app,/await import\('\.\/viewer.js'\)/);assert.match(app,/fallback\('3D graphics are unavailable/);assert.match(html,/not.*full|Eight authored room bays/);
});
