import assert from 'node:assert/strict';

// Cross-platform trigonometry/serialization may differ in the last float bits.
// At a one-meter coordinate this permits 1.1 micrometers, not visible geometry drift.
export const GLB_FLOAT_TOLERANCE=Object.freeze({absolute:1e-7,relative:1e-6});
const components={SCALAR:1,VEC2:2,VEC3:3,VEC4:4};
const formats={5126:{bytes:4,read:'readFloatLE',float:true},5123:{bytes:2,read:'readUInt16LE'},5125:{bytes:4,read:'readUInt32LE'}};

export function decodeKitGlb(bytes){
 assert.equal(bytes.toString('ascii',0,4),'glTF','GLB magic');assert.equal(bytes.readUInt32LE(4),2,'GLB version');assert.equal(bytes.readUInt32LE(8),bytes.length,'GLB container length');
 assert.equal(bytes.readUInt32LE(16),0x4e4f534a,'JSON chunk type');
 const jsonLength=bytes.readUInt32LE(12),binHeader=20+jsonLength;
 assert.equal(jsonLength%4,0,'JSON alignment');assert.ok(binHeader+8<=bytes.length,'BIN header fits');assert.equal(bytes.readUInt32LE(binHeader+4),0x004e4942,'BIN chunk type');
 const binary=bytes.subarray(binHeader+8),json=JSON.parse(bytes.toString('utf8',20,binHeader));
 assert.equal(bytes.readUInt32LE(binHeader),binary.length,'BIN length');assert.equal(json.buffers.length,1,'one embedded buffer');
 assert.ok(json.buffers[0].byteLength<=binary.length&&binary.length-json.buffers[0].byteLength<4,'embedded buffer length');
 return {json,binary};
}

function close(actual,expected,path){
 const {absolute,relative}=GLB_FLOAT_TOLERANCE;
 if(!Number.isFinite(actual)||!Number.isFinite(expected)||Math.abs(actual-expected)>absolute+relative*Math.max(Math.abs(actual),Math.abs(expected)))
  assert.fail(`${path}: float ${actual} differs from ${expected} beyond abs ${absolute} + rel ${relative}`);
}

export function assertEquivalentKitGlbs(actualBytes,expectedBytes,label='GLB'){
 const actual=decodeKitGlb(actualBytes),expected=decodeKitGlb(expectedBytes);
 function floatPath(path){
  if(/^nodes\.\d+\.matrix\.\d+$/.test(path))return true;
  if(/^materials\.\d+\.(emissiveFactor\.\d+|pbrMetallicRoughness\.(baseColorFactor\.\d+|metallicFactor|roughnessFactor))$/.test(path))return true;
  const match=/^accessors\.(\d+)\.(min|max)\.\d+$/.exec(path);
  return !!match&&expected.json.accessors[Number(match[1])].componentType===5126;
 }
 function compare(a,b,path){
  if(typeof a==='number'&&typeof b==='number'&&floatPath(path)){close(a,b,`${label}.${path}`);return;}
  if(b!==null&&typeof b==='object'){
   assert.ok(a!==null&&typeof a==='object',`${label}.${path}: object required`);
   assert.equal(Array.isArray(a),Array.isArray(b),`${label}.${path}: container type`);
   assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort(),`${label}.${path}: keys/array length`);
   for(const key of Object.keys(b))compare(a[key],b[key],path?`${path}.${key}`:key);
  }else assert.equal(a,b,`${label}.${path}: exact metadata/structure`);
 }
 compare(actual.json,expected.json,'');
 // Structure above fixes accessor types/counts, buffer offsets/strides and mesh indices.
 // Read actual payload values too, so stale interior vertices cannot hide behind equal bounds.
 for(const [index,accessor] of expected.json.accessors.entries()){
  assert.ok(!accessor.sparse,'sparse accessors are not produced by this kit');
  const format=formats[accessor.componentType],size=components[accessor.type],view=expected.json.bufferViews[accessor.bufferView];
  assert.ok(format&&size,'supported kit accessor');assert.equal(view.buffer,0,'embedded accessor buffer');
  const stride=view.byteStride??size*format.bytes,start=(view.byteOffset??0)+(accessor.byteOffset??0);
  const end=start+(accessor.count-1)*stride+size*format.bytes;
  assert.ok(end<=(view.byteOffset??0)+view.byteLength&&end<=actual.binary.length,'accessor fits its buffer view');
  for(let row=0;row<accessor.count;row++)for(let c=0;c<size;c++){
   const offset=start+row*stride+c*format.bytes,a=actual.binary[format.read](offset),b=expected.binary[format.read](offset);
   if(format.float)close(a,b,`${label}.accessors.${index}[${row},${c}]`);
   else if(a!==b)assert.fail(`${label}.accessors.${index}[${row},${c}]: integer/index ${a} differs from ${b}`);
  }
 }
}
