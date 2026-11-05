// Original illustrative PICU section. Meters, Y up; no mapping to real rooms.
export const WARD = Object.freeze({id:'picu', title:'Pediatric intensive care', location:'Bloomberg 4 South', fidelity:'Illustrative section — layout and placement unverified', bounds:{minX:-13,maxX:13,minZ:-9,maxZ:9}});
export const ROOMS = [-1,1].flatMap(side => [-9,-3,3,9].map((x,i)=>({id:`picu-room-${side<0?'a':'b'}${i+1}`,name:`Demo room ${side<0?'A':'B'}${i+1}`,x,z:side*5.9,side,doorX:x-1.65,view:[x-1.65,1.65,side*3.7]})));
export const LABELS = {infusion:'IV pump',monitor:'Monitor','supply-cart':'Supply cart','supply-cabinet':'Supply cabinet',recliner:'Family recliner',workstation:'Workstation',sink:'Handwash sink',stool:'Stool','pediatric-bed':'Pediatric bed'};
export const EQUIPMENT = ROOMS.flatMap(r => [
 {kind:'pediatric-bed',dx:.1,dz:6.4,w:1.25,d:2.35},
 {kind:'infusion',dx:-1.35,dz:7.2,w:.65,d:.65},
 {kind:'monitor',dx:1.35,dz:7.2,w:.65,d:.65},
 {kind:'recliner',dx:2,dz:7.8,w:.9,d:1.1},
 {kind:'sink',dx:2.35,dz:3.5,w:.85,d:.6},
 {kind:'supply-cart',dx:1.95,dz:5,w:.8,d:.7},
].map(p=>({id:`${r.id}-${p.kind}`,kind:p.kind,roomId:r.id,location:r.name,x:r.x+p.dx,z:r.side*p.dz,rotation:r.side>0?Math.PI:0,w:p.w,d:p.d,provenance:'Synthetic display placement; not tracked inventory'}))).concat([
 {id:'picu-desk-west',kind:'workstation',roomId:'picu-workspace',location:'Demo staff workspace',x:-1.65,z:0,rotation:Math.PI/2,w:1.65,d:1.6},
 {id:'picu-desk-east',kind:'workstation',roomId:'picu-workspace',location:'Demo staff workspace',x:1.65,z:0,rotation:-Math.PI/2,w:1.65,d:1.6},
 {id:'picu-store-pump-1',kind:'infusion',roomId:'picu-equipment-bay',location:'Demo equipment bay',x:11.7,z:-1.4,rotation:-Math.PI/2,w:.65,d:.65},
 {id:'picu-store-pump-2',kind:'infusion',roomId:'picu-equipment-bay',location:'Demo equipment bay',x:11.7,z:-.5,rotation:-Math.PI/2,w:.65,d:.65},
 {id:'picu-store-monitor',kind:'monitor',roomId:'picu-equipment-bay',location:'Demo equipment bay',x:11.7,z:.5,rotation:-Math.PI/2,w:.65,d:.65},
 {id:'picu-store-cart',kind:'supply-cart',roomId:'picu-equipment-bay',location:'Demo equipment bay',x:11.7,z:1.5,rotation:-Math.PI/2,w:.7,d:.8},
 {id:'picu-cabinet-west',kind:'supply-cabinet',roomId:'picu-workspace',location:'Demo staff workspace',x:0,z:.75,rotation:Math.PI,w:1.65,d:.6},
].map(p=>({...p,provenance:'Synthetic display placement; not tracked inventory'})));
// Collision footprint mirrors the architectural walls and the furniture in ward.js.
export const WALLS = [
 {x:0,z:-9,w:26,d:.16,h:2.85},{x:0,z:9,w:26,d:.16,h:2.85},
 {x:13,z:0,w:.16,d:18,h:2.85},{x:-13,z:-5.9,w:.16,d:6.2,h:2.85},{x:-13,z:5.9,w:.16,d:6.2,h:2.85},
 ...[-1,1].flatMap(s=>[-12,-6,0,6,12].map(x=>({x,z:s*5.9,w:.14,d:6.2,h:2.85}))),
 ...ROOMS.flatMap(r=>[{x:r.x-2.675,z:r.side*2.8,w:.65,d:.12,h:2.85},{x:r.x+1.025,z:r.side*2.8,w:3.95,d:.12,h:2.85,glass:true}]),
 {x:0,z:-1.12,w:6,d:.08,h:1.2,glass:true},{x:0,z:1.12,w:6,d:.08,h:1.2,glass:true},
];
export const OBSTACLES = [...WALLS,...EQUIPMENT];
export function isWalkable(x,z,radius=.22){
 const b=WARD.bounds;
 return Number.isFinite(x)&&Number.isFinite(z)&&x>=b.minX+radius&&x<=b.maxX-radius&&z>=b.minZ+radius&&z<=b.maxZ-radius&&!OBSTACLES.some(o=>Math.abs(x-o.x)<o.w/2+radius&&Math.abs(z-o.z)<o.d/2+radius);
}
// Small substeps prevent passing through thin walls even after a slow frame.
export function moveSafely(position,dx,dz){
 let [x,z]=position;const steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.08));
 for(let i=0;i<steps;i++){if(isWalkable(x+dx/steps,z))x+=dx/steps;if(isWalkable(x,z+dz/steps))z+=dz/steps;}
 return [x,z];
}
export function filterEquipment(query='',kind='all'){
 const q=query.trim().toLowerCase();return EQUIPMENT.filter(e=>(kind==='all'||e.kind===kind)&&`${e.id} ${LABELS[e.kind]} ${e.location}`.toLowerCase().includes(q));
}
export function validateConfig(){
 const ids=new Set();for(const e of EQUIPMENT){if(ids.has(e.id)||!e.id.startsWith('picu-'))throw Error('Invalid equipment identity');ids.add(e.id);if(!LABELS[e.kind]||![e.x,e.z,e.rotation,e.w,e.d].every(Number.isFinite))throw Error('Invalid placement');if(e.x-e.w/2<WARD.bounds.minX||e.x+e.w/2>WARD.bounds.maxX||e.z-e.d/2<WARD.bounds.minZ||e.z+e.d/2>WARD.bounds.maxZ)throw Error('Out of bounds');}
 for(const r of ROOMS)if(!isWalkable(r.view[0],r.view[2]))throw Error(`Blocked viewpoint ${r.id}`);
 return {rooms:ROOMS.length,equipment:ids.size};
}
