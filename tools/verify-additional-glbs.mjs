// Optional independent round-trip verification. Tooling is installed outside the application.
// Usage: node tools/verify-additional-glbs.mjs /path/to/asset-tools [report.json]
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {ADDITIONAL_ASSET_TYPES} from '../packages/scene/viewer/additional-assets.js';
if(!process.argv[2])throw Error('Pass the isolated toolchain directory containing three and gltf-validator');
const require=createRequire(pathToFileURL(resolve(process.argv[2],'package.json')));
const {validateBytes}=require('gltf-validator');
const {GLTFLoader}=await import(pathToFileURL(require.resolve('three/addons/loaders/GLTFLoader.js')));
const {Box3,Vector3}=await import(pathToFileURL(require.resolve('three')));
const dir=new URL('../packages/scene/viewer/assets/',import.meta.url),manifest=JSON.parse(readFileSync(new URL('manifest.json',dir)));
const report={validator:'Khronos glTF Validator',loader:'Three.js GLTFLoader',assets:[]};
for(const id of ADDITIONAL_ASSET_TYPES){
 const bytes=readFileSync(new URL(`${id}.glb`,dir)),validation=await validateBytes(new Uint8Array(bytes),{uri:`${id}.glb`});
 assert.equal(validation.issues.numErrors,0,`${id}: ${JSON.stringify(validation.issues.messages)}`);
 const parsed=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const bounds=new Box3().setFromObject(parsed.scene),size=bounds.getSize(new Vector3()).toArray(),expected=manifest.assets.find(a=>a.id===id);
 assert.ok(!bounds.isEmpty()&&[...bounds.min.toArray(),...size].every(Number.isFinite),id);
 size.forEach((v,i)=>assert.ok(Math.abs(v-expected.sizeMeters[i])<.0001,`${id}: loaded bounds`));
 report.assets.push({id,loaded:true,errors:validation.issues.numErrors,warnings:validation.issues.numWarnings,info:validation.issues.numInfos,sizeMeters:size.map(v=>+v.toFixed(4))});
}
if(process.argv[3])writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
