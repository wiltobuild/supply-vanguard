import * as THREE from 'three';
import {createAsset} from '../../models.js';
import {ROOMS,SUPPORT,EQUIPMENT} from './config.js';

// Geometry is an original illustrative section, not a reconstruction of a measured ward.
export function createPcuWard() {
 const root=new THREE.Group();root.name='pcu-illustrative-section';root.userData={units:'meters',up:'Y',confidence:'inferred',architecturalAccuracyClaimed:false};
 const obstacles=[],walls=[],ceilings=[],equipmentObjects=new Map(),assetInstances=[];
 const material=(color,options={})=>new THREE.MeshStandardMaterial({color,roughness:.78,...options});
 const m={wall:material(0xf4f3ec),trim:material(0xb4c5d4),floor:material(0xe2e4e3),hall:material(0xaec5dc),blue:material(0x7292be),oak:material(0xc7ac85),white:material(0xfdfbf5),metal:material(0x718490,{metalness:.55,roughness:.38}),glass:material(0xaccfdf,{transparent:true,opacity:.22,depthWrite:false}),window:material(0xd5eaf8,{emissive:0xa9c7de,emissiveIntensity:.2}),light:material(0xfff7dd,{emissive:0xffefd0,emissiveIntensity:.6}),linen:material(0xeaf0f5),accent:material(0xe6ad99),dark:material(0x506a82)};
 function box(name,w,h,d,x,y,z,mat,parent=root){const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);mesh.name=name;mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh;}
 function barrier(x,z,w,d){obstacles.push({x,z,w,d});}
 function wall(name,x,z,w,d,height=2.85,mat=m.wall){const group=new THREE.Group();group.name=name;root.add(group);box('wall',w,height,d,x,height/2,z,mat,group);box('skirting',w+.012,.11,d+.012,x,.055,z,m.trim,group);walls.push(group);barrier(x,z,w,d);return group;}
 function asset(kind,x,z,rotation=0,id=null){const model=createAsset(kind);model.position.set(x,0,z);model.rotation.y=rotation;model.name=id||`pcu-${kind}-${assetInstances.length}`;model.userData={...model.userData,wardId:'pcu-bloomberg-9n',equipmentId:id,confidence:'inferred'};root.add(model);assetInstances.push(model);if(id)equipmentObjects.set(id,model);const b=new THREE.Box3().setFromObject(model);barrier((b.min.x+b.max.x)/2,(b.min.z+b.max.z)/2,b.max.x-b.min.x,b.max.z-b.min.z);return model;}
 box('pcu-foundation',32.5,.32,18.5,0,-.2,0,m.dark);
 box('pcu-floor',32,.08,18,0,-.04,0,m.floor);
 box('pcu-corridor',31.8,.015,3.6,0,.012,0,m.hall);
 for(const side of [-1,1])box('pcu-hall-border',31.7,.02,.045,0,.018,side*1.6,m.white);
 wall('pcu-west-wall',-16,0,.15,18);wall('pcu-east-wall',16,0,.15,18);
 for(const side of [-1,1]){
  wall('pcu-window-sill',0,side*9,32,.16,.8);
  const windows=new THREE.Group();windows.name='pcu-window-band';root.add(windows);walls.push(windows);
  for(let x=-15;x<16;x+=1.6){box('pcu-glazing',1.5,1.8,.06,x,1.75,side*9,m.window,windows);box('pcu-mullion',.05,1.9,.12,x-.77,1.75,side*9,m.metal,windows);box('pcu-shade',1.48,.22,.08,x,2.52,side*8.92,m.blue,windows);}
  for(const x of [-11,-4.5,2,8.5])wall('pcu-room-partition',x,side*5.4,.14,7.2);
 }
 for(const room of ROOMS){
  const {x,side,doorX}=room,front=side*1.8,rotation=side<0?0:Math.PI;
  const min=x-3.25,max=x+3.25,left=doorX-.8-min,right=max-(doorX+.8);
  box(`${room.id}-floor`,6.33,.02,7.05,x,.018,side*5.4,m.linen);
  wall(`${room.id}-door-left`,min+left/2,front,left,.14);
  const glazing=new THREE.Group();glazing.name=`${room.id}-front`;root.add(glazing);walls.push(glazing);
  const paneX=doorX+.8+right/2;
  box('pcu-glass-base',right,.56,.14,paneX,.28,front,m.wall,glazing);
  box('pcu-glass',right,2.05,.05,paneX,1.58,front,m.glass,glazing);
  for(const xx of [doorX+.8,max])box('pcu-glass-frame',.05,2.65,.12,xx,1.33,front,m.metal,glazing);
  box('pcu-door-header',6.5,.2,.16,x,2.75,front,m.white,glazing);barrier(paneX,front,right,.14);
  box('pcu-threshold',1.6,.015,.18,doorX,.027,front,m.trim);
  ceilings.push(box(`${room.id}-ceiling`,6.35,.06,7.05,x,2.89,side*5.4,m.white));
  ceilings.push(box('pcu-light-panel',1.5,.025,.45,x,2.84,side*4.2,m.light));
  // Generic bed fixture: no brand claim; built locally to avoid changing the NICU library.
  const bed=new THREE.Group();bed.name=`${room.id}-representative-bed`;bed.position.set(x-.15,0,side*6);bed.rotation.y=rotation;root.add(bed);
  box('bed-base',1.03,.14,2.2,0,.42,0,m.metal,bed);box('bed-mattress',.95,.2,2.08,0,.65,0,m.white,bed);
  box('folded-cover',.97,.04,1.1,0,.77,.42,m.linen,bed);box('bed-pillow',.7,.12,.4,0,.8,-.7,m.white,bed);
  for(const zz of [-1.12,1.12]){box('bed-end',1.08,.46,.09,0,.78,zz,m.white,bed);box('bed-end-inset',.64,.18,.025,0,.81,zz+Math.sign(zz)*.05,m.blue,bed);}
  for(const xx of [-.54,.54])box('bed-side-rail',.06,.26,1.25,xx,.91,0,m.white,bed);
  for(const xx of [-.4,.4])for(const zz of [-.8,.8]){box('bed-leg',.08,.25,.08,xx,.25,zz,m.metal,bed);const wheel=new THREE.Mesh(new THREE.CylinderGeometry(.085,.085,.06,12),m.dark);wheel.rotation.z=Math.PI/2;wheel.position.set(xx,.1,zz);bed.add(wheel);}
  barrier(x-.15,side*6,1.2,2.5);
  asset('recliner',x-2.3,side*7.5,rotation);barrier(x-2.3,side*7.5,1,1.3);
  asset('sink',x+2.6,side*3.1,side<0?Math.PI/2:-Math.PI/2);barrier(x+2.6,side*3.1,.75,1);
  // A modest private-bath enclosure, with an open entry facing the bed.
  wall(`${room.id}-bath-front`,x+2.15,side*5.75,2.05,.12);
  wall(`${room.id}-bath-side`,x+1.16,side*8.2,.12,1.45);
  box('pcu-bath-floor',1.9,.025,3,x+2.15,.03,side*7.35,m.trim);
  box('pcu-bath-vanity',.7,.75,.5,x+2.45,.375,side*8.35,m.white);barrier(x+2.45,side*8.35,.7,.5);
  const service=box('pcu-headwall',2.5,.65,.12,x-.15,1.35,side*8.85,m.blue);walls.push(service);
  for(let i=0;i<4;i++)box('pcu-service-point',.1,.1,.03,x-.85+i*.45,1.38,side*8.76,i%2?m.white:m.metal);
  // Original abstract color panels; the copyrighted window illustration is not reproduced.
  for(let i=0;i<3;i++)box('pcu-art-panel',.32,.45+i*.1,.035,x-2.75+i*.43,1.7,side*8.83,[m.blue,m.accent,m.oak][i]);
  box('pcu-chart-ledge',1.05,.07,.36,x+2.1,1,side*1.54,m.oak);barrier(x+2.1,side*1.54,1.05,.36);
 }
 // Separate family and supply rooms at the west end of this illustrative section.
 for(const room of SUPPORT){const side=room.side;wall(`${room.id}-front-left`,-15.15,side*1.8,1.7,.14);wall(`${room.id}-front-right`,-11.85,side*1.8,1.7,.14);ceilings.push(box(`${room.id}-ceiling`,4.85,.06,7.05,-13.5,2.89,side*5.4,m.white));}
 for(const x of [-14.7,-12.7]){asset('supply-cabinet',x,-8.4);barrier(x,-8.4,1.7,.7);}
 asset('workstation',-14.8,-6.4,Math.PI/2);barrier(-14.8,-6.4,1.4,1.3);
 for(const x of [-14.6,-12.5]){asset('recliner',x,7.5,Math.PI);barrier(x,7.5,1,1.3);}
 box('pcu-family-table',1.1,.06,.7,-13.5,.65,5.8,m.oak);box('pcu-table-leg',.12,.6,.12,-13.5,.3,5.8,m.metal);barrier(-13.5,5.8,1.1,.7);
 for(const item of EQUIPMENT){const room=[...ROOMS,...SUPPORT].find(r=>r.id===item.locationId);asset(item.kind,item.x,item.z,room.side<0?0:Math.PI,item.id);barrier(item.x,item.z,item.kind==='supply-cart'?1:.65,.7);}
 function setCutaway(on){for(const wall of walls)wall.visible=!on;for(const ceiling of ceilings)ceiling.visible=false;/* Roof stays absent for useful interior cameras. */}
 // Low perimeter and partition guides keep the plan legible in the roofless overview.
 const guides=new THREE.Group();guides.name='pcu-cutaway-guides';root.add(guides);
 for(const o of obstacles.filter(o=>o.w<.2||o.d<.2))box('pcu-low-wall',o.w,.45,o.d,o.x,.225,o.z,m.wall,guides);
 const setViewCutaway=on=>{setCutaway(on);guides.visible=on;};setViewCutaway(true);
 return {root,obstacles,equipmentObjects,assetInstances,setCutaway:setViewCutaway};
}
