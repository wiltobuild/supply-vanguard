import * as THREE from 'three';
import {createAsset} from '../../models.js';
import {ROOMS,EQUIPMENT,WALLS,WARD} from './config.js';
export function createPicu(){
 const root=new THREE.Group();root.name='PICU_Illustrative_Section';root.userData={wardId:'picu',units:'meters',accuracy:WARD.fidelity};
 const tall=[],ceilings=[],items=new Map();
 const material=(color,extra={})=>new THREE.MeshStandardMaterial({color,roughness:.8,...extra});
 const m={wall:material('#f1eee7'),blue:material('#8ba9c5'),floor:material('#e2dfd4'),hall:material('#abc5d0'),white:material('#fbfaf4'),wood:material('#b99c7a'),steel:material('#8d9fa5',{metalness:.5,roughness:.3}),dark:material('#435763'),glass:material('#c9e3eb',{transparent:true,opacity:.19,depthWrite:false,roughness:.2}),window:material('#d6eaf2',{emissive:'#a8cedd',emissiveIntensity:.22}),light:material('#fff6d9',{emissive:'#fff1cd',emissiveIntensity:.6})};
 const geometry=new Map();
 function box(parent,name,w,h,d,x,y,z,mat){let key=[w,h,d].join(':');if(!geometry.has(key))geometry.set(key,new THREE.BoxGeometry(w,h,d));const mesh=new THREE.Mesh(geometry.get(key),mat);mesh.name=name;mesh.position.set(x,y,z);mesh.castShadow=!mat.transparent;mesh.receiveShadow=true;parent.add(mesh);return mesh;}
 box(root,'foundation',26.4,.28,18.4,0,-.19,0,m.dark);box(root,'floor',26,.1,18,0,-.05,0,m.floor);box(root,'corridor',25.8,.015,5.6,0,.01,0,m.hall);
 ceilings.push(box(root,'corridor-ceiling',26,.05,5.6,0,2.9,0,m.white));
 for(const z of [-1.9,1.9])for(const x of [-9,-3,3,9])ceilings.push(box(root,'corridor-light',2.5,.025,.18,x,2.86,z,m.light));
 for(const z of [-2.55,2.55])box(root,'corridor-border',25.7,.008,.07,0,.022,z,m.white);
 for(const w of WALLS){
  const group=new THREE.Group();root.add(group);tall.push(group);
  box(group,'partition',w.w,w.h,w.d,w.x,w.h/2,w.z,w.glass?m.glass:m.wall);
  box(group,'skirting',w.w+.01,.1,w.d+.01,w.x,.05,w.z,m.steel);
  if(w.glass){box(group,'frame',w.w,.04,w.d+.02,w.x,w.h,w.z,m.steel);for(const s of [-1,1])box(group,'upright',.04,w.h,w.d+.02,w.x+s*w.w/2,w.h/2,w.z,m.steel);}
 }
 for(const r of ROOMS){
  box(root,`${r.id}-floor`,5.8,.018,6,r.x,.012,r.z,m.white);
  // The room accent/window wall is an interpretation of public pediatric imagery.
  const upper=new THREE.Group();root.add(upper);tall.push(upper);
  box(upper,'blue-accent',5.8,1.7,.03,r.x,1.95,r.side*8.89,m.blue);
  box(upper,'window',2.2,1.35,.04,r.x-1.55,1.82,r.side*8.85,m.window);
  for(const dx of [-2.68,-.42])box(upper,'window-frame',.055,1.46,.08,r.x+dx,1.82,r.side*8.80,m.white);
  box(upper,'window-shade',2.3,.15,.13,r.x-1.55,2.53,r.side*8.78,m.wood);
  box(root,'clinical-panel',2.4,.5,.08,r.x+.45,1.35,r.side*8.81,m.white);
  for(let i=0;i<5;i++)box(root,'abstract-outlet',.08,.08,.04,r.x-.35+i*.32,1.38,r.side*8.75,i%2?m.steel:m.blue);
  box(root,'door-threshold',1.4,.015,.2,r.doorX,.025,r.side*2.8,m.steel);
  box(root,'door-plaque',.25,.18,.03,r.x-2.65,1.5,r.side*2.71,m.blue);
  const ceiling=box(root,'acoustic-ceiling',5.85,.05,6.05,r.x,2.9,r.z,m.white);ceilings.push(ceiling);
  ceilings.push(box(root,'ceiling-light',1.5,.025,.35,r.x,2.86,r.z,m.light));
 }
 // Original generic bed needed for pediatric scale; all other equipment uses the existing kit.
 function bed(){const g=new THREE.Group();g.name='representative-pediatric-bed';
  box(g,'pedestal',.58,.36,.9,0,.35,0,m.white);box(g,'base',1.05,.12,1.85,0,.21,0,m.steel);box(g,'deck',1.1,.14,2.15,0,.62,0,m.white);box(g,'mattress',.96,.15,1.98,0,.76,0,m.white);box(g,'blanket',.98,.035,1.35,0,.855,.28,m.blue);box(g,'pillow',.7,.1,.35,0,.88,-.7,m.white);
  for(const z of [-1.08,1.08]){box(g,'end-board',1.13,.5,.065,0,.85,z,m.white);box(g,'board-inset',.75,.17,.07,0,.91,z,m.blue);}
  for(const x of [-.58,.58]){box(g,'side-rail',.045,.06,1.5,x,1.08,0,m.white);for(const z of [-.7,0,.7])box(g,'rail-post',.04,.34,.04,x,.91,z,m.steel);}
  const wheelGeo=new THREE.CylinderGeometry(.085,.085,.06,12);for(const x of [-.46,.46])for(const z of [-.8,.8]){const o=new THREE.Mesh(wheelGeo,m.dark);o.rotation.z=Math.PI/2;o.position.set(x,.085,z);g.add(o);}
  return g;
 }
 for(const e of EQUIPMENT){const a=e.kind==='pediatric-bed'?bed():createAsset(e.kind);a.position.set(e.x,0,e.z);a.rotation.y=e.rotation;a.name=e.id;a.userData={...a.userData,equipmentId:e.id,roomId:e.roomId,wardId:'picu',provenance:e.provenance};root.add(a);items.set(e.id,a);}
 // Direction labels are model-local. No geographic north or hospital wayfinding claims.
 function setCutaway(on){for(const o of tall)o.scale.y=on?.32:1;for(const o of ceilings)o.visible=!on;}
 setCutaway(true);return {root,items,setCutaway};
}
