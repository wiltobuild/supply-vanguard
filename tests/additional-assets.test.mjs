import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {THREE,createAsset,createWard,ASSET_TYPES} from '../tools/scene-assets-runtime.mjs';
import {encodeSceneGlb} from '../tools/scene-glb.mjs';
import {ADDITIONAL_ASSET_TYPES,ADDITIONAL_PLACEMENTS} from '../packages/scene/viewer/additional-assets.js';
import {ROOMS,INITIAL_LOCATIONS,ASSET_LABELS} from '../packages/scene/viewer/data.js';
import {isWalkable,findPath} from '../packages/scene/viewer/nav.js';
import {planPlacements,MODEL_REGISTRY} from '../packages/scene/viewer/config.js';
import {seedEquipment} from '../packages/domain/seed.js';
const assets=new URL('../packages/scene/viewer/assets/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('manifest.json',assets)));
test('all twelve original GLBs are preserved byte for byte',()=>{
 const hashes=JSON.parse(readFileSync(new URL('./fixtures/original-glbs.sha256.json',import.meta.url)));
 assert.equal(Object.keys(hashes).length,12);
 for(const [name,hash] of Object.entries(hashes))assert.equal(createHash('sha256').update(readFileSync(new URL(name,assets))).digest('hex'),hash,name);
});
test('fifteen procedural models and deterministic GLBs have finite matching bounds and provenance',()=>{
 assert.equal(ADDITIONAL_ASSET_TYPES.length,15);assert.equal(ASSET_TYPES.length,25);
 for(const kind of ADDITIONAL_ASSET_TYPES){
  const model=createAsset(kind),bounds=new THREE.Box3().setFromObject(model),record=manifest.assets.find(a=>a.id===kind),file=readFileSync(new URL(`${kind}.glb`,assets));
  assert.ok(ASSET_LABELS[kind]);assert.equal(model.userData.tracked,false);assert.equal(model.userData.units,'meters');assert.equal(model.userData.upAxis,'Y');
  assert.ok(!bounds.isEmpty());assert.ok([...bounds.min.toArray(),...bounds.max.toArray()].every(Number.isFinite));assert.ok(bounds.min.y>=-.00001);
  assert.ok(bounds.getSize(new THREE.Vector3()).length()<3,kind);assert.deepEqual(file,encodeSceneGlb(model),`${kind} export is current`);
  assert.equal(record.bytes,file.length);assert.equal(record.role,'static-decoration');
  const json=JSON.parse(file.toString('utf8',20,20+file.readUInt32LE(12)));assert.equal(json.asset.version,'2.0');assert.equal(json.nodes[0].extras.tracked,false);
  for(const accessor of json.accessors){assert.ok(accessor.count>0);assert.ok([...accessor.min,...accessor.max].every(Number.isFinite));}
  assert.ok(record.triangles>=2000&&record.triangles<=32000,`${kind} follows existing kit complexity`);
 }
 assert.equal(Object.keys(MODEL_REGISTRY).length,5,'static additions do not expand tracked inventory');
});
test('decorations avoid existing geometry, other additions and initial tracked equipment',()=>{
 const ward=createWard(),added=ward.assetInstances.filter(a=>a.userData.role==='static-decoration');assert.equal(added.length,15);
 const obstacles=ward.obstacles.slice(0,-added.length),boxes=added.map(a=>new THREE.Box3().setFromObject(a));
 const seeded=[...planPlacements(seedEquipment()).values()].map(p=>{const a=createAsset(p.modelKind);a.position.fromArray(p.position);return {id:p.id,bounds:new THREE.Box3().setFromObject(a)};});
 added.forEach((a,i)=>{
  assert.ok(!a.userData.equipmentId&&!a.userData.locationId);assert.ok(![...ward.locationObjects.values()].includes(a));
  const b=boxes[i],s=b.getSize(new THREE.Vector3()),c=b.getCenter(new THREE.Vector3());
  assert.ok(b.min.x>-11.42&&b.max.x<11.42&&b.min.z>-6.92&&b.max.z<6.92,a.name);
  for(const o of obstacles)assert.ok(!(Math.abs(c.x-o.x)<(s.x+o.w)/2-.015&&Math.abs(c.z-o.z)<(s.z+o.d)/2-.015),`${a.name} overlaps original obstacle`);
  for(const other of boxes.slice(i+1))assert.ok(!b.intersectsBox(other),`${a.name} overlaps another addition`);
  for(const p of seeded)assert.ok(!b.intersectsBox(p.bounds),`${a.name} overlaps ${p.id}`);
 });
 assert.deepEqual(ADDITIONAL_PLACEMENTS,manifest.additionalCollection.placements);
});
test('corridor, exact door approaches and all supply destinations remain reachable',()=>{
 const {obstacles}=createWard(),start=[-10.8,0];
 for(let x=-10.8;x<=10.8;x+=.25)assert.ok(isWalkable(x,0,obstacles),'central corridor');
 const targets=[...ROOMS.map(r=>({name:r.id,end:[r.doorX,r.side*2.2]})),...INITIAL_LOCATIONS.map(l=>({name:l.id,end:l.approach})),{name:'charging-bays',end:[-8.55,2.4]}];
 for(const {name,end} of targets){
  assert.ok(isWalkable(...end,obstacles),`${name}: requested endpoint must not be snapped`);
  const path=findPath(start,end,obstacles);assert.ok(path.length>1,name);assert.deepEqual(path.at(-1),end);
  for(const point of path)assert.ok(isWalkable(...point,obstacles),`${name}: collision-free path`);
 }
});
