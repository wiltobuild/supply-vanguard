import * as THREE from 'three';
import {createAsset} from './models.js';
import {ADDITIONAL_ASSETS} from './additional-assets.js';
const grid=document.querySelector('#grid'),entries=[];
let renderer;
for(const [id,a] of Object.entries(ADDITIONAL_ASSETS)){
 const card=document.createElement('article');card.innerHTML=`<div class="model" role="img" aria-label="${a.label} render"></div><div class="caption"><span class="number">${String(entries.length+1).padStart(2,'0')}</span><h2>${a.label}</h2><p>${a.detail}</p><a href="assets/${id}.glb" download>Download GLB</a></div>`;grid.append(card);
 const scene=new THREE.Scene();scene.background=new THREE.Color('#e8eeea');const model=createAsset(id);scene.add(model);
 scene.add(new THREE.HemisphereLight(0xffffff,0xa8b9ad,2.6));const key=new THREE.DirectionalLight(0xfff5e4,3);key.position.set(-3,5,4);scene.add(key);const fill=new THREE.DirectionalLight(0xc4deef,1.3);fill.position.set(3,2,-3);scene.add(fill);
 const bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
 const camera=new THREE.PerspectiveCamera(35,1,.01,30),distance=Math.max(size.x,size.y,size.z)*2.3;camera.position.copy(center).add(new THREE.Vector3(distance*.65,distance*.4,distance));camera.lookAt(center);
 entries.push({scene,camera,element:card.querySelector('.model')});
}
try{
 // One offscreen renderer produces static previews. Images flow with the cards on resize/scroll.
 // Interactive orbit controls remain in the main asset library.
 renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;renderer.setSize(480,270);
 for(const {scene,camera,element} of entries){camera.aspect=480/270;camera.updateProjectionMatrix();renderer.render(scene,camera);const preview=document.createElement('img');preview.alt='';preview.width=480;preview.height=270;preview.style.cssText='width:100%;height:100%;object-fit:contain';preview.src=renderer.domElement.toDataURL('image/png');element.append(preview);}
 document.querySelector('#status').textContent=`${entries.length} models rendered. All are illustrative, untracked scene additions.`;
}catch{
 document.querySelector('#status').textContent='3D previews are unavailable in this browser. All fifteen model descriptions and GLB downloads remain available below.';
 for(const {element} of entries){element.removeAttribute('role');element.removeAttribute('aria-label');element.hidden=true;}
}finally{renderer?.dispose();renderer?.forceContextLoss();}
