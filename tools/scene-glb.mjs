// Deterministic, texture-free GLB 2.0 writer for this procedural kit's static Mesh/Group hierarchy.
// Unsupported features fail explicitly; this is not a general-purpose Three.js exporter.
export function encodeSceneGlb(root){
 const json={asset:{version:'2.0',generator:'Supply Vanguard procedural asset exporter'},scene:0,scenes:[{nodes:[0]}],nodes:[],meshes:[],materials:[],accessors:[],bufferViews:[],buffers:[{byteLength:0}]};
 const chunks=[],geometries=new Map(),materials=new Map();let offset=0;
 function accessor(attribute,target){
  if(attribute.isInterleavedBufferAttribute||attribute.normalized)throw Error('Unsupported packed attribute');
  const array=attribute.array,componentType=array instanceof Float32Array?5126:array instanceof Uint16Array?5123:array instanceof Uint32Array?5125:null;
  if(!componentType)throw Error('Unsupported attribute component type');
  const data=Buffer.from(array.buffer,array.byteOffset,array.byteLength),padding=(4-data.length%4)%4;
  const view=json.bufferViews.push({buffer:0,byteOffset:offset,byteLength:data.length,target})-1;chunks.push(data,Buffer.alloc(padding));offset+=data.length+padding;
  const item={bufferView:view,componentType,count:attribute.count,type:({1:'SCALAR',2:'VEC2',3:'VEC3',4:'VEC4'})[attribute.itemSize]};
  if(!item.type)throw Error('Unsupported attribute size');
  const min=Array(attribute.itemSize).fill(Infinity),max=Array(attribute.itemSize).fill(-Infinity);
  for(let i=0;i<array.length;i++){if(!Number.isFinite(array[i]))throw Error('Non-finite geometry');const c=i%attribute.itemSize;min[c]=Math.min(min[c],array[i]);max[c]=Math.max(max[c],array[i]);}
  item.min=min;item.max=max;return json.accessors.push(item)-1;
 }
 function material(m){
  if(materials.has(m))return materials.get(m);
  if(!m.isMeshStandardMaterial||m.map)throw Error('Only texture-free standard materials supported');
  const item={name:m.name||`material-${materials.size}`,pbrMetallicRoughness:{baseColorFactor:[...m.color.toArray(),m.opacity],metallicFactor:m.metalness,roughnessFactor:m.roughness}};
  if(m.transparent)item.alphaMode='BLEND';if(m.side===2)item.doubleSided=true;
  const emission=m.emissive.toArray().map(v=>v*m.emissiveIntensity);if(emission.some(v=>v))item.emissiveFactor=emission;
  const index=json.materials.push(item)-1;materials.set(m,index);return index;
 }
 function geometry(g){
  if(geometries.has(g))return geometries.get(g);
  const p={attributes:{}};for(const [name,semantic] of [['position','POSITION'],['normal','NORMAL'],['uv','TEXCOORD_0']])if(g.getAttribute(name))p.attributes[semantic]=accessor(g.getAttribute(name),34962);
  if(g.index)p.indices=accessor(g.index,34963);geometries.set(g,p);return p;
 }
 function node(o){
  if(o.isInstancedMesh||o.isSkinnedMesh)throw Error('Only static meshes supported');
  o.updateMatrix();const item={name:o.name||o.type,matrix:o.matrix.toArray()},index=json.nodes.push(item)-1;
  if(Object.keys(o.userData).length)item.extras=structuredClone(o.userData);
  if(o.isMesh){if(Array.isArray(o.material))throw Error('Multi-material mesh unsupported');item.mesh=json.meshes.push({primitives:[{...geometry(o.geometry),material:material(o.material)}]})-1;}
  if(o.children.length)item.children=o.children.map(node);return index;
 }
 node(root);json.buffers[0].byteLength=offset;
 const raw=Buffer.from(JSON.stringify(json)),text=Buffer.concat([raw,Buffer.alloc((4-raw.length%4)%4,0x20)]),binary=Buffer.concat(chunks);
 const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+text.length+binary.length,8);header.writeUInt32LE(text.length,12);header.writeUInt32LE(0x4e4f534a,16);
 const binHeader=Buffer.alloc(8);binHeader.writeUInt32LE(binary.length);binHeader.writeUInt32LE(0x004e4942,4);
 return Buffer.concat([header,text,binHeader,binary]);
}
