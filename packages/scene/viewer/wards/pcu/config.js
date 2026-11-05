// SV-026: authored demonstration coordinates, meters / Y up. No real room mapping.
export const WARD = Object.freeze({id:'pcu-bloomberg-9n', title:'Pediatric cardiac step-down', location:'Bloomberg 9 North', accuracy:'Illustrative section · not a measured floor plan', units:'meters', up:'Y', route:'/ward/wards/pcu/index.html'});
export const LIMITS = Object.freeze({minX:-15.8,maxX:15.8,minZ:-8.8,maxZ:8.8});
export const ROOMS = Object.freeze([-1,1].flatMap((side,row)=>[-7.75,-1.25,5.25,11.75].map((x,col)=>Object.freeze({id:`pcu-bay-${row?'b':'a'}${col+1}`,name:`Illustrative bay ${row?'B':'A'}${col+1}`,short:`${row?'B':'A'}${col+1}`,x,z:side*5.4,side,doorX:x-1.5,width:6.5,depth:7.2,approach:[x-1.5,side*3.4],confidence:'inferred'}))));
export const SUPPORT = Object.freeze([
 {id:'pcu-supply',name:'Illustrative equipment store',short:'STORE',x:-13.5,z:-5.4,side:-1,doorX:-13.5,approach:[-13.5,-3.4],confidence:'inferred'},
 {id:'pcu-family',name:'Illustrative family room',short:'FAMILY',x:-13.5,z:5.4,side:1,doorX:-13.5,approach:[-13.5,3.4],confidence:'inferred'}
]);
export const LOCATIONS = Object.freeze([...ROOMS,...SUPPORT]);
export const MODEL_LABELS = Object.freeze({infusion:'IV pump',monitor:'Patient monitor','supply-cart':'Supply cart',recliner:'Family recliner',sink:'Handwash sink',workstation:'Workstation','supply-cabinet':'Supply cabinet'});
export const EQUIPMENT = Object.freeze([
 ...ROOMS.flatMap(r=>[
  {id:`${r.id}-iv`,kind:'infusion',locationId:r.id,x:r.x-1.2,z:r.side*6.1},
  {id:`${r.id}-monitor`,kind:'monitor',locationId:r.id,x:r.x+.9,z:r.side*6.2},
  {id:`${r.id}-cart`,kind:'supply-cart',locationId:r.id,x:r.x+1,z:r.side*3.1}
 ]),
 {id:'pcu-store-iv',kind:'infusion',locationId:'pcu-supply',x:-12.2,z:-5.1},
 {id:'pcu-store-cart',kind:'supply-cart',locationId:'pcu-supply',x:-14.6,z:-5.1}
].map(e=>Object.freeze({...e,name:MODEL_LABELS[e.kind],provenance:'Synthetic example; not actual stock or a confirmed location'})));
export const SOURCES = Object.freeze([
 {title:'Hopkins: progressive pediatric cardiac care (2021)',url:'https://www.hopkinsmedicine.org/news/articles/2021/10/a-new-progressive-pediatric-cardiac-care-unit',supports:'Historical PCU on the ninth floor. Does not establish current room geometry.'},
 {title:'Hopkins careers: Bloomberg 9 North',url:'https://jobs.hopkinsmedicine.org/job/103658/registered-nurse-pediatric-cardiac-step-down-transplant-and-general-care-unit-nursing-us-md-baltimore-johns-hopkins-hospital/',supports:'Identifies the 20-bed cardiac step-down, transplant and general care unit. Capacity is not a floor plan.'},
 {title:'Hopkins nursing: NICU and PICU locations',url:'https://www.hopkinsmedicine.org/nursing/specialties-units/pediatric-neonatal-icu',supports:'NICU at Bloomberg 8 North: this ward is one floor level above, not a verified walking route.'},
 {title:'Hopkins: patient rooms and interior photograph',url:'https://www.hopkinsmedicine.org/johns-hopkins-childrens-center/patients-and-families/bloomberg-childrens-center/patient-rooms',supports:'Building-wide private rooms, baths, family sleeping space and distributed workstations. Photo informs blue finishes, white bed and bedside monitor; it is not identified as 9 North.'}
]);
export function filterEquipment(query='',kind='all') {
 const q=String(query).trim().toLowerCase();
 return EQUIPMENT.filter(e=>(kind==='all'||e.kind===kind)&&`${e.id} ${e.name} ${LOCATIONS.find(r=>r.id===e.locationId)?.name}`.toLowerCase().includes(q));
}
export function isWalkable(x,z,obstacles,radius=.24) {
 if(!Number.isFinite(x)||!Number.isFinite(z)||x<LIMITS.minX+radius||x>LIMITS.maxX-radius||z<LIMITS.minZ+radius||z>LIMITS.maxZ-radius)return false;
 return !obstacles.some(o=>x>o.x-o.w/2-radius&&x<o.x+o.w/2+radius&&z>o.z-o.d/2-radius&&z<o.z+o.d/2+radius);
}
// Axis-separated small steps prevent crossing thin walls at low frame rates.
export function moveWithinBounds(position,dx,dz,obstacles) {
 let [x,z]=position;const steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.08));
 for(let i=0;i<steps;i++){if(isWalkable(x+dx/steps,z,obstacles))x+=dx/steps;if(isWalkable(x,z+dz/steps,obstacles))z+=dz/steps;}
 return [x,z];
}
