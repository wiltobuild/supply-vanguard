import {ADDITIONAL_ASSET_LABELS} from './additional-assets.js';
export const SOURCES = [
 {title:'NICU parent guide · 2024',url:'https://www.hopkinsmedicine.org/-/media/johns-hopkins-childrens-center/documents/specialties/neonatal-medicine/a-parents-guide-to-the-nicu-english-2024.pdf',supports:'Private-room furnishings, family sleep chair, family facilities and representative clinical equipment.'},
 {title:'NICU design · Johns Hopkins',url:'https://www.hopkinsmedicine.org/news/articles/2012/07/nicu-design-with-less-movement-in-mind',supports:'Eighth-floor location, private rooms, proximity to Labor & Delivery and family accommodations. Historical source, 2012.'},
 {title:'Patient-room design · Johns Hopkins',url:'https://www.hopkinsmedicine.org/johns-hopkins-childrens-center/patients-and-families/bloomberg-childrens-center/patient-rooms',supports:'NICU rubber flooring, distributed workstations and quiet interior design.'},
 {title:'Bloomberg Tower public map',url:'https://www.hopkinsmedicine.org/-/media/hse/maps/bloomberg-tower-north-south.pdf',supports:'Building context only. Not verified as a dimensioned eighth-floor NICU plan.'},
 {title:'Architectural project · Perkins&Will',url:'https://perkinswill.com/project/the-johns-hopkins-hospital-sheikh-zayed-tower-and-the-charlotte-r-bloomberg-childrens-center/',supports:'Building material and circulation references. Does not verify this section layout.'}
];
export const ROOMS = [
 ...[-1,4,9].map((x,i)=>({id:`room-${101+i}`,name:`Infant room ${101+i}`,number:101+i,x,z:-4.25,side:-1,doorX:x-1.45,area:27.5})),
 ...[-1,4,9].map((x,i)=>({id:`room-${104+i}`,name:`Infant room ${104+i}`,number:104+i,x,z:4.25,side:1,doorX:x-1.45,area:27.5})),
 {id:'clean-supply',name:'Clean supply',x:-9.5,z:-4.25,doorX:-10.3,side:-1,area:22},
 {id:'staff-base',name:'Staff workroom',x:-5.5,z:-4.25,doorX:-6.3,side:-1,area:22},
 {id:'equipment-store',name:'Equipment store',x:-9.5,z:4.25,doorX:-10.3,side:1,area:22},
 {id:'family-lounge',name:'Family lounge',x:-5.5,z:4.25,doorX:-6.3,side:1,area:22}
];
export const INITIAL_LOCATIONS = [
 {id:'CS-A',name:'Supply cabinet A',room:'Clean supply',roomId:'clean-supply',position:[-10.5,1.4,-6.5],approach:[-10.1,-5.45],assetKind:'supply-cabinet',items:[{id:'gloves-xs',name:'Nitrile gloves · XS',bin:'A-01',unit:'boxes',quantity:3,par:12},{id:'gauze',name:'Sterile gauze · 2 × 2',bin:'A-02',unit:'packs',quantity:32,par:40},{id:'syringe-1',name:'1 mL syringes',bin:'A-03',unit:'units',quantity:12,par:60}]},
 {id:'CS-B',name:'Supply cabinet B',room:'Clean supply',roomId:'clean-supply',position:[-8.5,1.4,-6.5],approach:[-8.5,-5.45],assetKind:'supply-cabinet',items:[{id:'diaper',name:'Preemie diapers',bin:'B-01',unit:'packs',quantity:14,par:16},{id:'wipes',name:'Gentle wipes',bin:'B-02',unit:'packs',quantity:18,par:24},{id:'electrodes',name:'Neonatal electrodes',bin:'B-03',unit:'sets',quantity:4,par:20}]},
 {id:'EQ-A',name:'Equipment staging',room:'Equipment store',roomId:'equipment-store',position:[-10,1.1,5.9],approach:[-9.6,4.6],assetKind:'supply-cart',items:[{id:'pump',name:'Infusion pumps',bin:'EQ-01',unit:'units',quantity:2,par:4},{id:'monitor',name:'Portable monitors',bin:'EQ-02',unit:'units',quantity:2,par:2}]},
 ...[101,102,103,104,105,106].map((number,i)=>({id:`BR-${number}`,name:`Bedside cart ${number}`,room:`Infant room ${number}`,roomId:`room-${number}`,position:[[-1,4,9][i%3]+1.65,1.1,i<3?-3.15:3.15],approach:[[-1,4,9][i%3]+0.7,i<3?-2.7:2.7],assetKind:'supply-cart',items:[{id:`gloves-${number}`,name:'Nitrile gloves · S',bin:'Top drawer',unit:'boxes',quantity:i===1?1:5,par:6},{id:`gauze-${number}`,name:'Sterile gauze · 2 × 2',bin:'Middle drawer',unit:'packs',quantity:i===4?2:10,par:12}]}))
];
export const ASSET_LABELS = {'incubator':'Neonatal incubator','warmer':'Radiant warmer','monitor':'Patient monitor','infusion':'Infusion stand','recliner':'Family sleep chair','supply-cabinet':'Supply cabinet','supply-cart':'Bedside supply cart','workstation':'Clinical workstation','sink':'Hand hygiene station','stool':'Clinical stool',...ADDITIONAL_ASSET_LABELS};
export const MANIFEST = {version:'1.0.0',name:'Baltimore NICU reference section',units:'meters',upAxis:'Y',dimensions:{width:23,depth:14,height:2.85},roomCount:6,accuracy:'Reference-based reconstruction; all dimensions, room numbering, adjacencies, inventory and equipment brands are illustrative. Not an as-built survey.',roomIds:ROOMS.map(r=>r.id),sources:SOURCES};
export function stockState(location){return location.items.some(i=>i.quantity<=i.par*.3)?'low':location.items.some(i=>i.quantity<i.par*.65)?'watch':'ready';}
