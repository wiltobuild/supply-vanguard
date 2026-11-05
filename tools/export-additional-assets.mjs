import {readFileSync,writeFileSync} from 'node:fs';
import {THREE,createAsset} from './scene-assets-runtime.mjs';
import {encodeSceneGlb} from './scene-glb.mjs';
import {ADDITIONAL_ASSETS,ADDITIONAL_ASSET_TYPES,ADDITIONAL_PLACEMENTS,DECORATION_PROVENANCE} from '../packages/scene/viewer/additional-assets.js';
const dir=new URL('../packages/scene/viewer/assets/',import.meta.url),manifest=JSON.parse(readFileSync(new URL('manifest.json',dir),'utf8'));
manifest.assets=manifest.assets.filter(a=>!ADDITIONAL_ASSET_TYPES.includes(a.id));
for(const id of ADDITIONAL_ASSET_TYPES){
 const model=createAsset(id),bounds=new THREE.Box3().setFromObject(model),data=encodeSceneGlb(model);let triangles=0;
 model.traverse(o=>{if(o.isMesh)triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;});
 writeFileSync(new URL(`${id}.glb`,dir),data);
 manifest.assets.push({id,label:ADDITIONAL_ASSETS[id].label,file:`${id}.glb`,sizeMeters:bounds.getSize(new THREE.Vector3()).toArray().map(n=>+n.toFixed(4)),boundsMin:bounds.min.toArray().map(n=>+n.toFixed(4)),triangles,bytes:data.length,pivot:'floor-reference origin',front:'+Z',upAxis:'Y',role:'static-decoration',tracked:false,provenance:DECORATION_PROVENANCE});
 console.log(`${id}: ${triangles} triangles, ${data.length} bytes`);
}
manifest.additionalCollection={version:'1.0.0',source:'../additional-models.js',placements:ADDITIONAL_PLACEMENTS,provenance:DECORATION_PROVENANCE};
manifest.ward.snapshotNote='The two original ward GLBs are preserved baseline snapshots. The live procedural ward includes the fifteen additional decorative models; download those individually.';
manifest.integration.navigationNote='navigation.json accompanies the preserved baseline ward exports. The live procedural ward adds collision bounds from additionalCollection.placements and each model.';
writeFileSync(new URL('manifest.json',dir),JSON.stringify(manifest,null,2)+'\n');
