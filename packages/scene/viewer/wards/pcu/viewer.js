import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {createPcuWard} from './ward.js';
import {LOCATIONS,EQUIPMENT,isWalkable,moveWithinBounds} from './config.js';

export function mountViewer({container,markers,onSelect,onMode}) {
 const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;
 const canvas=renderer.domElement;canvas.tabIndex=0;canvas.setAttribute('aria-label','3D cardiac step-down ward. Drag to orbit; in walk mode use W A S D or arrow keys. Escape returns to overview.');container.append(canvas);
 const scene=new THREE.Scene();scene.background=new THREE.Color('#e8eff6');
 const camera=new THREE.PerspectiveCamera(42,1,.05,220);camera.rotation.order='YXZ';
 const orbit=new OrbitControls(camera,canvas);orbit.enableDamping=true;orbit.dampingFactor=.12;orbit.maxPolarAngle=Math.PI*.48;orbit.minDistance=3;orbit.maxDistance=130;
 scene.add(new THREE.HemisphereLight(0xffffff,0x8a9aac,2.2));const sun=new THREE.DirectionalLight(0xfff4e1,2.5);sun.position.set(-15,28,15);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-23,right:23,top:19,bottom:-19,near:.5,far:80});sun.shadow.bias=-.00025;scene.add(sun);
 const ward=createPcuWard();scene.add(ward.root);
 const ground=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:0xe8eff6,roughness:1}));ground.rotation.x=-Math.PI/2;ground.position.y=-.38;ground.receiveShadow=true;scene.add(ground);
 const rings=new Map(),ringGeometry=new THREE.RingGeometry(.46,.55,40),ringMaterial=new THREE.MeshBasicMaterial({color:0x1a63ae,side:THREE.DoubleSide,transparent:true,opacity:.85,depthWrite:false});
 for(const item of EQUIPMENT){const ring=new THREE.Mesh(ringGeometry,ringMaterial);ring.rotation.x=-Math.PI/2;ring.position.set(item.x,.065,item.z);ring.visible=false;ward.root.add(ring);rings.set(item.id,ring);}
 const selection=new THREE.Mesh(new THREE.RingGeometry(.6,.7,48),new THREE.MeshBasicMaterial({color:0xd74832,side:THREE.DoubleSide}));selection.rotation.x=-Math.PI/2;selection.visible=false;ward.root.add(selection);
 const labels=LOCATIONS.map(room=>{const node=document.createElement('span');node.className='room-marker';node.textContent=room.short;markers.append(node);return {room,node,position:new THREE.Vector3(room.x,1,room.z)};});
 let mode='overview',cutaway=true,dirty=true,yaw=0,pitch=0,pointer=null,last=performance.now();const keys=new Set(),projected=new THREE.Vector3();
 function invalidate(){dirty=true;}
 orbit.addEventListener('change',invalidate);
 function refreshShadow(){renderer.shadowMap.needsUpdate=true;invalidate();}
 function fitOverview(){const scale=Math.max(1,1.05/camera.aspect);camera.position.set(30*scale,31*scale,36*scale);orbit.target.set(0,0,0);}
 function overview(){mode='overview';keys.clear();orbit.enabled=true;camera.fov=42;fitOverview();camera.updateProjectionMatrix();ward.setCutaway(cutaway);onMode(mode);refreshShadow();}
 function look(){camera.rotation.set(pitch,yaw,0,'YXZ');invalidate();}
 function enter(x,z,targetX,targetZ){if(!isWalkable(x,z,ward.obstacles))throw new Error('Unsafe illustrative camera position');mode='walk';keys.clear();orbit.enabled=false;camera.fov=64;camera.position.set(x,1.62,z);camera.lookAt(targetX,1.1,targetZ);yaw=camera.rotation.y;pitch=camera.rotation.x;camera.updateProjectionMatrix();ward.setCutaway(false);onMode(mode);refreshShadow();canvas.focus({preventScroll:true});}
 function visit(room){enter(...room.approach,room.x,room.side*6);}
 function walk(){enter(-13.5,0,2,0);}
 function select(item){selection.position.set(item.x,.075,item.z);selection.visible=true;if(mode==='overview'){orbit.target.set(item.x,.6,item.z);camera.position.set(item.x+5,8,item.z+8);camera.updateProjectionMatrix();}invalidate();}
 function highlight(ids){const set=new Set(ids),filtered=ids.length<EQUIPMENT.length;for(const [id,ring] of rings)ring.visible=filtered&&set.has(id);invalidate();}
 function moveKey(key,on){if(on&&mode==='walk')keys.add(key);else keys.delete(key);invalidate();}
 const codeMap={KeyW:'forward',ArrowUp:'forward',KeyS:'back',ArrowDown:'back',KeyA:'left',ArrowLeft:'left',KeyD:'right',ArrowRight:'right'};
 canvas.addEventListener('keydown',event=>{if(event.code==='Escape'){overview();return;}if(mode==='walk'&&codeMap[event.code]){event.preventDefault();moveKey(codeMap[event.code],true);}});
 window.addEventListener('keyup',event=>{if(codeMap[event.code])moveKey(codeMap[event.code],false);});
 canvas.addEventListener('blur',()=>keys.clear());window.addEventListener('blur',()=>{keys.clear();pointer=null;});
 document.addEventListener('visibilitychange',()=>{keys.clear();invalidate();});
 canvas.addEventListener('pointerdown',event=>{canvas.focus({preventScroll:true});pointer={x:event.clientX,y:event.clientY,lastX:event.clientX,lastY:event.clientY,button:event.button};if(mode==='walk')canvas.setPointerCapture(event.pointerId);invalidate();});
 canvas.addEventListener('pointermove',event=>{if(!pointer)return;if(mode==='walk'&&pointer.button===0){yaw-=(event.clientX-pointer.lastX)*.004;pitch=Math.max(-1.1,Math.min(1.1,pitch-(event.clientY-pointer.lastY)*.003));look();}pointer.lastX=event.clientX;pointer.lastY=event.clientY;});
 const raycaster=new THREE.Raycaster(),mouse=new THREE.Vector2();
 canvas.addEventListener('pointerup',event=>{if(!pointer)return;const clicked=pointer.button===0&&Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)<5;pointer=null;if(!clicked)return;const bounds=canvas.getBoundingClientRect();mouse.set((event.clientX-bounds.left)/bounds.width*2-1,-(event.clientY-bounds.top)/bounds.height*2+1);raycaster.setFromCamera(mouse,camera);
  // Include walls/furnishings in the raycast so hidden equipment cannot be clicked through walls.
  const hit=raycaster.intersectObject(ward.root,true).find(h=>h.object.visible&&h.object!==selection&&!ringsHas(h.object)&&ancestorsVisible(h.object));if(!hit)return;let object=hit.object;while(object&&!object.userData.equipmentId)object=object.parent;if(object)onSelect(object.userData.equipmentId);
 });
 function ringsHas(object){return object.geometry===ringGeometry;}
 function ancestorsVisible(object){for(let o=object;o;o=o.parent)if(!o.visible)return false;return true;}
 canvas.addEventListener('pointercancel',()=>{pointer=null;keys.clear();});
 canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();keys.clear();renderer.setAnimationLoop(null);const message=document.createElement('p');message.id='loading';message.textContent='3D graphics were interrupted. Equipment search and source notes remain available; reload to try again.';container.append(message);for(const b of document.querySelectorAll('.scene-toolbar button,[data-move],[data-room]'))b.disabled=true;});
 function resize(){const width=container.clientWidth,height=container.clientHeight;renderer.setSize(width,height);camera.aspect=width/Math.max(1,height);if(mode==='overview')fitOverview();camera.updateProjectionMatrix();invalidate();}
 const resizeObserver=new ResizeObserver(resize);resizeObserver.observe(container);
 renderer.setAnimationLoop(now=>{const dt=Math.min(.05,(now-last)/1000);last=now;if(document.hidden)return;if(mode==='overview')orbit.update();if(mode==='walk'&&keys.size){let dx=Number(keys.has('right'))-Number(keys.has('left')),dz=Number(keys.has('back'))-Number(keys.has('forward'));const length=Math.hypot(dx,dz);if(length){dx/=length;dz/=length;const [x,z]=moveWithinBounds([camera.position.x,camera.position.z],(dx*Math.cos(yaw)+dz*Math.sin(yaw))*dt*2.2,(-dx*Math.sin(yaw)+dz*Math.cos(yaw))*dt*2.2,ward.obstacles);camera.position.set(x,1.62,z);invalidate();}}
  if(!dirty)return;dirty=false;for(const label of labels){let show=mode==='overview';if(show){projected.copy(label.position).project(camera);show=projected.z>-1&&projected.z<1&&Math.abs(projected.x)<.96&&Math.abs(projected.y)<.8;if(show){label.node.style.left=`${(projected.x*.5+.5)*container.clientWidth}px`;label.node.style.top=`${(-projected.y*.5+.5)*container.clientHeight}px`;}}label.node.hidden=!show;}renderer.render(scene,camera);
 });
 overview();resize();
 function saveView(){
  renderer.render(scene,camera);
  // Export the actual rendered camera view with an inseparable provenance caption.
  const output=document.createElement('canvas');output.width=Math.max(900,canvas.width);const imageHeight=Math.round(canvas.height*output.width/canvas.width);output.height=imageHeight+110;const context=output.getContext('2d');
  context.fillStyle='#f8fbff';context.fillRect(0,0,output.width,output.height);context.drawImage(canvas,0,0,output.width,imageHeight);context.fillStyle='#16222e';context.font='bold 22px Arial';context.fillText('Supply Vanguard · Pediatric cardiac step-down',22,imageHeight+34);context.font='16px Arial';context.fillText('Illustrative section — inferred layout, synthetic equipment. Not a measured hospital floor plan.',22,imageHeight+63);context.fillStyle='#536170';context.font='14px Arial';context.fillText(`Bloomberg 9 North reference · ${mode==='walk'?'Interior camera':'Overview camera'} · SV-026`,22,imageHeight+88);
  output.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`pcu-${mode}-illustrative.jpg`;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);},'image/jpeg',.93);
 }
 return {overview,walk,visit,select,highlight,moveKey,saveView,cutaway(on){cutaway=on;if(mode==='overview')ward.setCutaway(on);refreshShadow();}};
}
