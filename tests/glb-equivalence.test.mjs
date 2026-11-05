import test from 'node:test';
import assert from 'node:assert/strict';
import {THREE} from '../tools/scene-assets-runtime.mjs';
import {encodeSceneGlb} from '../tools/scene-glb.mjs';
import {assertEquivalentKitGlbs,decodeKitGlb} from './helpers/glb-equivalence.mjs';

const root=new THREE.Group();root.userData={tracked:false,units:'meters'};
const mesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial({color:'#468d92'}));root.add(mesh);
const original=encodeSceneGlb(root);
// Repack altered content, including arbitrary JSON whitespace/length, as a valid GLB.
function changed(edit){
 const {json,binary:source}=decodeKitGlb(original),binary=Buffer.from(source);edit(json,binary);
 const raw=Buffer.from(JSON.stringify(json,null,1)),text=Buffer.concat([raw,Buffer.alloc((4-raw.length%4)%4,0x20)]),header=Buffer.alloc(20),binHeader=Buffer.alloc(8);
 header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+text.length+binary.length,8);header.writeUInt32LE(text.length,12);header.writeUInt32LE(0x4e4f534a,16);
 binHeader.writeUInt32LE(binary.length);binHeader.writeUInt32LE(0x004e4942,4);return Buffer.concat([header,text,binHeader,binary]);
}
function attributeOffset(json,semantic){const primitive=json.meshes[0].primitives[0],index=semantic==='indices'?primitive.indices:primitive.attributes[semantic],accessor=json.accessors[index];return (json.bufferViews[accessor.bufferView].byteOffset??0)+(accessor.byteOffset??0);}

test('new-export comparison accepts harmless JSON layout and float roundoff across runtimes',()=>{
 const roundoff=changed((json,binary)=>{
  json.nodes[1].matrix[0]+=1e-12;json.materials[0].pbrMetallicRoughness.baseColorFactor[0]+=1e-12;
  const offset=attributeOffset(json,'POSITION');binary.writeFloatLE(binary.readFloatLE(offset)+1e-7,offset);
 });
 assert.notEqual(roundoff.length,original.length,'different JSON chunk length is harmless');assertEquivalentKitGlbs(roundoff,original);
});
test('new-export comparison rejects stale interior geometry and non-finite payloads',()=>{
 for(const semantic of ['POSITION','NORMAL','TEXCOORD_0']){
  assert.throws(()=>assertEquivalentKitGlbs(changed((j,b)=>{const o=attributeOffset(j,semantic);b.writeFloatLE(b.readFloatLE(o)+.001,o);}),original),/beyond/);
 }
 assert.throws(()=>assertEquivalentKitGlbs(changed((j,b)=>b.writeFloatLE(NaN,attributeOffset(j,'POSITION'))),original),/beyond/);
});
test('new-export comparison rejects changed transforms, materials and bounds',()=>{
 for(const edit of [j=>{j.nodes[1].matrix[12]+=.001;},j=>{j.materials[0].pbrMetallicRoughness.roughnessFactor-=.01;},j=>{j.accessors[0].max[0]+=.001;}])
  assert.throws(()=>assertEquivalentKitGlbs(changed(edit),original),/beyond/);
});
test('new-export comparison keeps metadata, structure and integer indices exact',()=>{
 for(const edit of [j=>{j.nodes[0].extras.tracked=true;},j=>{j.nodes[1].mesh=1;},j=>{j.accessors[0].count--;}])
  assert.throws(()=>assertEquivalentKitGlbs(changed(edit),original),/exact metadata\/structure/);
 assert.throws(()=>assertEquivalentKitGlbs(changed((j,b)=>{const o=attributeOffset(j,'indices');b.writeUInt16LE(b.readUInt16LE(o)+1,o);}),original),/integer\/index/);
});
