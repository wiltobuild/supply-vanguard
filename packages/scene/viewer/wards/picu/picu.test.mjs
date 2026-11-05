import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {register} from 'node:module';
import {WARD,ROOMS,EQUIPMENT,filterEquipment,isWalkable,moveSafely,validateConfig} from './config.js';
import {WARD_ROUTES,routeAvailable} from '../ward-links.js';
register('./three-loader.mjs',import.meta.url);
const THREE=await import('../../vendor/three.module.js');
const {createPicu}=await import('./ward.js');

test('stable ward-local identities, valid room mapping and finite meter placements',()=>{
 assert.deepEqual(validateConfig(),{rooms:8,equipment:55});
 const locations=new Set([...ROOMS.map(r=>r.id),'picu-workspace','picu-equipment-bay']);
 for(const e of EQUIPMENT)assert.ok(locations.has(e.roomId),e.id);
 assert.equal(new Set(ROOMS.map(r=>r.id)).size,8);
});
test('all modeled equipment loads with finite bounds inside the section',()=>{
 const ward=createPicu();assert.equal(ward.items.size,EQUIPMENT.length);ward.root.updateMatrixWorld(true);
 for(const e of EQUIPMENT){const model=ward.items.get(e.id);assert.equal(model.userData.equipmentId,e.id);const b=new THREE.Box3().setFromObject(model);for(const n of [...b.min.toArray(),...b.max.toArray()])assert.ok(Number.isFinite(n),e.id);assert.ok(!b.isEmpty(),e.id);assert.ok(b.min.x>=WARD.bounds.minX&&b.max.x<=WARD.bounds.maxX&&b.min.z>=WARD.bounds.minZ&&b.max.z<=WARD.bounds.maxZ,e.id);}
 const identities=[...ward.items.values()];ward.setCutaway(false);ward.setCutaway(true);assert.deepEqual([...ward.items.values()],identities,'view changes preserve objects and IDs');
});
test('every room viewpoint is reachable from the entry without crossing fixtures',()=>{
 const step=.2,start=[-11,0],queue=[start],visited=new Set([start.join(',')]);let cursor=0;
 const key=(x,z)=>`${x.toFixed(1)},${z.toFixed(1)}`;visited.add(key(...start));
 while(cursor<queue.length){const [x,z]=queue[cursor++];for(const [dx,dz] of [[step,0],[-step,0],[0,step],[0,-step]]){const xx=Math.round((x+dx)*10)/10,zz=Math.round((z+dz)*10)/10,k=key(xx,zz);if(!visited.has(k)&&isWalkable(xx,zz)){visited.add(k);queue.push([xx,zz]);}}}
 for(const r of ROOMS)assert.ok(queue.some(([x,z])=>Math.hypot(x-r.view[0],z-r.view[2])<.21),r.id);
 assert.ok(queue.some(([x,z])=>Math.hypot(x-9,z)<.21),'equipment bay approach');
 assert.ok(queue.length>3000,'meaningful accessible floor area');
});
test('walking cannot tunnel through partitions or leave the model',()=>{
 const result=moveSafely([-3,0],0,-20);assert.ok(result[1]>-2.6,'stops before closed glazed frontage');
 assert.ok(isWalkable(...result));const outside=moveSafely([-11,0],-100,0);assert.ok(outside[0]>=WARD.bounds.minX+.22);assert.equal(isWalkable(NaN,0),false);
});
test('equipment type and text search locate every pump without implying live stock',()=>{
 const pumps=filterEquipment('','infusion');assert.equal(pumps.length,10);assert.equal(new Set(pumps.map(e=>e.id)).size,10);assert.ok(pumps.every(e=>e.kind==='infusion'));assert.equal(filterEquipment('a1','infusion').length,1);assert.equal(filterEquipment('IV pump').length,10);assert.equal(filterEquipment('unmatched').length,0);
});
test('ward navigation never offers unavailable routes',async()=>{
 assert.equal(WARD_ROUTES.find(r=>r.id==='picu').href,'/ward/wards/picu/index.html');
 assert.equal(await routeAvailable(WARD_ROUTES[2],async()=>({ok:false})),false);
 assert.equal(await routeAvailable(WARD_ROUTES[2],async()=>{throw Error('offline');}),false);
 assert.equal(await routeAvailable(WARD_ROUTES[2],async()=>({ok:true,text:async()=>'<html><body data-ward="pcu">PCU preview</body></html>'})),true);
 assert.equal(await routeAvailable(WARD_ROUTES[2],async()=>({ok:true,text:async()=>'<html><body data-ward="picu">PICU preview</body></html>'})),false);
 assert.equal(await routeAvailable(WARD_ROUTES[2],async()=>({ok:true,text:async()=>'Not found'})),false);
});
test('source register distinguishes location evidence from illustrative geometry',()=>{
 const r=JSON.parse(readFileSync(new URL('references.json',import.meta.url)));assert.equal(r.wardId,'picu');assert.equal(r.safety.operationalInventory,false);assert.ok(r.inferred.some(s=>s.includes('Eight authored')));assert.ok(r.sources.some(s=>s.id==='hopkins-job'&&s.limitations.some(v=>v.includes('Conflicts'))));
 for(const s of r.sources){assert.ok(s.url.startsWith('https://'));assert.ok(s.inspected);assert.ok(s.limitations.length);}
});
