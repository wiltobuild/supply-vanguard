// Ward and model configuration (SV-002). Pure data and rules, no Three.js, so it can be validated in Node.
// Units are meters, Y up. Equipment identity is the stable equipment ID; meshes are disposable render objects.
import {ROOMS,ASSET_LABELS} from './data.js';
import {LIMITS} from './nav.js';
export const MODEL_REGISTRY=Object.freeze({
 incubator:{glb:'assets/incubator.glb'},
 infusion:{glb:'assets/infusion.glb'},
 monitor:{glb:'assets/monitor.glb'},
 warmer:{glb:'assets/warmer.glb'},
 'supply-cart':{glb:'assets/supply-cart.glb'}
});
export const SLOT_LAYOUT=Object.freeze({columns:3,spacingX:.9,spacingZ:.8,offsetX:-1,offsetZ:.6});
// Where the Nth item parked in a room stands. Same arrangement the viewer used before this was extracted.
export function slotPosition(room,slot,layout=SLOT_LAYOUT){
 return [room.x+layout.offsetX+(slot%layout.columns)*layout.spacingX,0,room.z+room.side*(layout.offsetZ+Math.floor(slot/layout.columns)*layout.spacingZ)];
}
// Items in rooms that do not exist are left out (the list view still shows them); items with an unknown model are rejected.
// Pass the previous plan so an item that stays in its room keeps its slot while others come and go.
export function planPlacements(items,rooms=ROOMS,registry=MODEL_REGISTRY,previous=new Map()){
 const byRoom=new Map(rooms.map(r=>[r.id,r])),used=new Map(),placements=new Map(),pending=[];
 const take=(roomId,slot)=>{if(!used.has(roomId))used.set(roomId,new Set());used.get(roomId).add(slot);};
 for(const item of items){
  if(!item||typeof item.id!=='string'||!item.id)throw new Error('Equipment ID is required');
  if(placements.has(item.id)||pending.some(p=>p.id===item.id))throw new Error(`Duplicate equipment ID ${item.id}`);
  if(!Object.hasOwn(registry,item.modelKind))throw new Error(`Unknown model kind for ${item.id}`);
  const room=byRoom.get(item.roomId);if(!room)continue;
  const old=previous.get(item.id);
  if(old&&old.roomId===room.id&&!used.get(room.id)?.has(old.slot)){take(room.id,old.slot);placements.set(item.id,{id:item.id,modelKind:item.modelKind,roomId:room.id,slot:old.slot,position:slotPosition(room,old.slot)});}
  else pending.push({id:item.id,modelKind:item.modelKind,room});
 }
 const order=new Map(items.map((i,n)=>[i.id,n]));
 for(const p of pending){let slot=0;while(used.get(p.room.id)?.has(slot))slot++;take(p.room.id,slot);placements.set(p.id,{id:p.id,modelKind:p.modelKind,roomId:p.room.id,slot,position:slotPosition(p.room,slot)});}
 return new Map([...placements].sort((a,b)=>order.get(a[0])-order.get(b[0])));
}
// Compares two plans by equipment ID so a move reuses the existing mesh instead of replacing it.
export function diffPlacements(previous,next){
 const added=[],moved=[],removed=[],retyped=[];
 for(const [id,p] of next){const old=previous.get(id);if(!old)added.push(id);else if(old.modelKind!==p.modelKind)retyped.push(id);else if(old.roomId!==p.roomId||old.position.some((v,i)=>v!==p.position[i]))moved.push(id);}
 for(const id of previous.keys())if(!next.has(id))removed.push(id);
 return {added,moved,removed,retyped};
}
const meters=v=>Array.isArray(v)&&v.length>=2&&v.every(Number.isFinite);
// Throws on the first problem; returns a summary when the configuration is usable.
export function validateSceneConfig({rooms=ROOMS,registry=MODEL_REGISTRY,locations=[],assetLabels=ASSET_LABELS,limits=LIMITS}={}){
 const ids=new Set();
 for(const r of rooms){
  if(typeof r.id!=='string'||!r.id)throw new Error('Room ID is required');
  if(ids.has(r.id))throw new Error(`Duplicate room ID ${r.id}`);ids.add(r.id);
  if(![r.x,r.z,r.doorX].every(Number.isFinite))throw new Error(`Room ${r.id} needs finite meter coordinates`);
  if(r.side!==1&&r.side!==-1)throw new Error(`Room ${r.id} side must be 1 or -1`);
  if(r.x<limits.minX||r.x>limits.maxX||r.z<limits.minZ||r.z>limits.maxZ)throw new Error(`Room ${r.id} is outside the ward bounds`);
 }
 const locIds=new Set();
 for(const l of locations){
  if(typeof l.id!=='string'||!l.id)throw new Error('Location ID is required');
  if(locIds.has(l.id))throw new Error(`Duplicate location ID ${l.id}`);locIds.add(l.id);
  if(!ids.has(l.roomId))throw new Error(`Location ${l.id} refers to unknown room ${l.roomId}`);
  if(!Array.isArray(l.position)||l.position.length!==3||!l.position.every(Number.isFinite))throw new Error(`Location ${l.id} needs a 3-number meter position`);
  if(!meters(l.approach))throw new Error(`Location ${l.id} needs a meter approach point`);
  if(l.position[0]<limits.minX||l.position[0]>limits.maxX||l.position[2]<limits.minZ||l.position[2]>limits.maxZ)throw new Error(`Location ${l.id} is outside the ward bounds`);
 }
 for(const [kind,m] of Object.entries(registry)){
  if(!Object.hasOwn(assetLabels,kind))throw new Error(`Model kind ${kind} is not a known asset type`);
  if(typeof m.glb!=='string'||!/^assets\/[\w-]+\.glb$/.test(m.glb))throw new Error(`Model ${kind} needs an assets/*.glb path`);
 }
 return {rooms:ids.size,locations:locIds.size,models:Object.keys(registry).length};
}
