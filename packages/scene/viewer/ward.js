import * as THREE from 'three';
import {createAsset} from './models.js';
import {ROOMS,INITIAL_LOCATIONS} from './data.js';
import {ADDITIONAL_PLACEMENTS,DECORATION_PROVENANCE} from './additional-assets.js';
export function createWard(){
 const root=new THREE.Group();root.name='SupplySentry_NICU_Reference_Section';root.userData={units:'meters',accuracy:'Inferred section layout. See manifest.json.'};
 const walls=[],ceilings=[],obstacles=[],locationObjects=new Map(),assetInstances=[];
 const mats={wall:new THREE.MeshStandardMaterial({color:0xe8e6dd,roughness:.9}),trim:new THREE.MeshStandardMaterial({color:0xc0c7bc,roughness:.65}),floor:new THREE.MeshStandardMaterial({color:0xd8ded5,roughness:.88}),hall:new THREE.MeshStandardMaterial({color:0xb8c9bb,roughness:.82}),oak:new THREE.MeshStandardMaterial({color:0xb8a081,roughness:.8}),white:new THREE.MeshStandardMaterial({color:0xf7f6ef,roughness:.75}),metal:new THREE.MeshStandardMaterial({color:0x7e9591,metalness:.65,roughness:.32}),glass:new THREE.MeshStandardMaterial({color:0x9dc7c3,transparent:true,opacity:.21,roughness:.2,metalness:.15,depthWrite:false}),window:new THREE.MeshStandardMaterial({color:0xd7e6df,roughness:.35,emissive:0x8cafa9,emissiveIntensity:.2}),light:new THREE.MeshStandardMaterial({color:0xfff9d7,emissive:0xffe8aa,emissiveIntensity:1})};
 function box(name,w,h,d,x,y,z,mat,parent=root){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);m.name=name;m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
 function barrier(x,z,w,d){obstacles.push({x,z,w,d});}
 function wall(name,x,z,w,d,height=2.85){const g=new THREE.Group();g.name=name;root.add(g);box('wall',w,height,d,x,height/2,z,mats.wall,g);box('baseboard',w+.015,.12,d+.015,x,.06,z,mats.trim,g);walls.push(g);barrier(x,z,w,d);return g;}
 function asset(kind,x,z,rotation=0,id){const a=createAsset(kind);a.name=id||`${kind}_${assetInstances.length}`;a.position.set(x,0,z);a.rotation.y=rotation;a.userData.assetKind=kind;if(id){a.userData.locationId=id;locationObjects.set(id,a);}root.add(a);assetInstances.push(a);return a;}
 box('foundation',23.55,.35,14.55,0,-.205,0,new THREE.MeshStandardMaterial({color:0x697e70,roughness:.9}));
 box('rubber_floor',23,.08,14,0,-.04,0,mats.floor);
 box('central_corridor',22.85,.012,3,0,.008,0,mats.hall);
 for(const z of [-1.35,1.35])box('corridor_inlay',22.7,.014,.035,0,.016,z,mats.white);
 // A quiet terrazzo-like rubber floor, modeled rather than using photographic textures.
 const chipGeo=new THREE.BoxGeometry(.018,.003,.035),chipMat=new THREE.MeshStandardMaterial({color:0xb9c5ba,roughness:1});
 let seed=831;function rand(){seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;}
 const chips=new THREE.InstancedMesh(chipGeo,chipMat,2200);chips.name='rubber_floor_flecks';const dummy=new THREE.Object3D();for(let i=0;i<2200;i++){dummy.position.set((rand()-.5)*22.8,.005,(rand()-.5)*13.8);dummy.rotation.y=rand()*Math.PI;dummy.updateMatrix();chips.setMatrixAt(i,dummy.matrix);}root.add(chips);
 wall('east_wall',11.5,0,.16,14);wall('west_north',-11.5,-4.2,.16,5.6);wall('west_south',-11.5,4.2,.16,5.6);
 for(const s of [-1,1]){
  // Exterior sill and clerestory windows; higher window layers hide in overview.
  wall('exterior_sill',0,s*7,23,.16,1.05);
  const windowGroup=new THREE.Group();windowGroup.name='exterior_windows';root.add(windowGroup);walls.push(windowGroup);
  for(let x=-10.5;x<11;x+=1.65){box('window_glazing',1.58,1.5,.06,x,1.88,s*7,mats.window,windowGroup);box('window_mullion',.05,1.62,.12,x-.81,1.88,s*7,mats.metal,windowGroup);box('shade_upper',1.57,.18,.09,x,2.6,s*6.92,mats.oak,windowGroup);}
  box('window_header',23,.18,.2,0,2.76,s*7,mats.wall,windowGroup);
  for(const x of [-7.5,-3.5,1.5,6.5])wall('room_divider',x,s*4.25,.14,5.5);
 }
 for(const r of ROOMS){
  const infant=!!r.number,w=infant?5:4,min=r.x-w/2,max=r.x+w/2,dx=r.doorX,z=r.side*1.5;
  const roomRoot=new THREE.Group();roomRoot.name=r.id;roomRoot.userData={roomId:r.id,sourceConfidence:'inferred'};root.add(roomRoot);
  box('room_floor',w-.15,.014,5.32,r.x,.012,r.z,new THREE.MeshStandardMaterial({color:infant?(r.side<0?0xe4dfca:0xd5e1dd):r.id==='clean-supply'?0xd7dfcd:0xe0dfd6,roughness:.9}),roomRoot);
  const leftW=dx-.7-min,rightW=max-(dx+.7);
  if(leftW>.05)wall('door_left',min+leftW/2,z,leftW,.12);
  const frontGroup=new THREE.Group();frontGroup.name=`${r.id}_glazed_front`;root.add(frontGroup);walls.push(frontGroup);
  box('glazed_wall_base',rightW,.55,.12,dx+.7+rightW/2,.275,z,mats.wall,frontGroup);
  box('glazed_partition',rightW,2.05,.045,dx+.7+rightW/2,1.58,z,mats.glass,frontGroup);
  barrier(dx+.7+rightW/2,z,rightW,.12);
  for(const xx of [dx+.7,max])box('frame',.055,2.6,.1,xx,1.3,z,mats.metal,frontGroup);
  box('header',w,.24,.16,r.x,2.73,z,mats.white,frontGroup);
  // Open sliding leaf sits over the fixed pane. The doorway is 1.4 m clear.
  box('open_sliding_door',1.3,2.35,.045,dx+1.4,1.22,z-r.side*.08,mats.glass,frontGroup);
  box('door_handle',.035,.42,.075,dx+.82,1.08,z-r.side*.14,mats.metal,frontGroup);
  box('threshold',1.4,.01,.18,dx,.017,z,mats.trim);
  const ceiling=box(`${r.id}_ceiling`,w-.12,.05,5.35,r.x,2.86,r.z,mats.white);ceilings.push(ceiling);
  const light=box('ceiling_light',1.4,.025,.32,r.x,2.82,r.z,mats.light);ceilings.push(light);
  if(infant){
   const backZ=r.side*5.15,rot=r.side<0?0:Math.PI;
   const bed=asset(r.number===103||r.number===106?'warmer':'incubator',r.x+.15,backZ,rot);bed.userData.roomId=r.id;barrier(r.x+.15,backZ,1.1,1.65);
   asset('monitor',r.x+1.35,r.side*5.5,rot);barrier(r.x+1.35,r.side*5.5,.65,.65);
   asset('infusion',r.x-.8,r.side*5.65,rot);barrier(r.x-.8,r.side*5.65,.65,.65);
   asset('recliner',r.x-1.55,r.side*5.75,rot);barrier(r.x-1.55,r.side*5.75,.9,1.15);
   asset('supply-cart',r.x+1.65,r.side*3.15,rot,`BR-${r.number}`);barrier(r.x+1.65,r.side*3.15,1,.7);
   asset('sink',r.x+1.8,r.side*2.05,r.side<0?Math.PI:0);barrier(r.x+1.8,r.side*2.05,.9,.6);
   // Rear clinical service panel: sockets, medical gas outlets, task lamp.
   box('service_panel',2.15,.62,.09,r.x+.3,1.36,r.side*6.88,mats.white);
   for(let j=0;j<6;j++)box('service_outlet',.09,.09,.04,r.x-.5+j*.28,1.4,r.side*6.8,new THREE.MeshStandardMaterial({color:[0x647d76,0xb99d65,0xdedbd0][j%3]}));
   // Abstract circular wall accents; original geometry, not copied artwork.
   for(let j=0;j<3;j++){const c=new THREE.Mesh(new THREE.CircleGeometry(.12+j*.035,24),new THREE.MeshStandardMaterial({color:[0xb9c579,0x97b9b1,0xd6b778][j]}));c.position.set(r.x-1.55+j*.32,1.65+j*.17,r.side*6.9);c.rotation.y=r.side>0?Math.PI:0;root.add(c);}
  }
 }
 asset('supply-cabinet',-10.5,-6.5,0,'CS-A');barrier(-10.5,-6.5,1.65,.6);
 asset('supply-cabinet',-8.5,-6.5,0,'CS-B');barrier(-8.5,-6.5,1.65,.6);
 asset('supply-cabinet',-10.8,-3.5,Math.PI/2);barrier(-10.8,-3.5,.65,1.65);
 asset('supply-cart',-8.3,-3.5);barrier(-8.3,-3.5,1,.7);
 asset('workstation',-5.7,-5.8);barrier(-5.7,-5.4,1.5,1.55);
 asset('workstation',-4.1,-3.5,-Math.PI/2);barrier(-4.5,-3.5,1.55,1.5);
 asset('supply-cart',-10,5.9,Math.PI,'EQ-A');barrier(-10,5.9,1,.8);
 asset('infusion',-8.4,5.8);barrier(-8.4,5.8,.65,.7);
 asset('monitor',-8.5,3.1);barrier(-8.5,3.1,.65,.65);
 asset('warmer',-10.5,3.2,Math.PI/2);barrier(-10.5,3.2,1.5,1);
 asset('recliner',-6.6,5.6,Math.PI);barrier(-6.6,5.6,.9,1.15);
 asset('recliner',-4.5,5.6,Math.PI);barrier(-4.5,5.6,.9,1.15);
 box('family_table',.65,.05,.65,-5.5,.55,4.3,mats.oak);box('table_leg',.08,.52,.08,-5.5,.26,4.3,mats.metal);barrier(-5.5,4.3,.65,.65);
 // Corridor wall protectors, doorway plaques and distributed charting ledges.
 for(const r of ROOMS){box('room_plaque',.25,.18,.04,r.doorX-.9,1.5,r.side*1.41,new THREE.MeshStandardMaterial({color:r.number?0x628b83:0xb6a565}));}
 for(const s of [-1,1])for(const x of [4.6,9.6]){box('charting_ledge',1.05,.07,.32,x,.99,s*1.22,mats.oak);barrier(x,s*1.22,1.05,.32);}
 // Static illustrative additions are deliberately separate from location and equipment identity maps.
 for(const p of ADDITIONAL_PLACEMENTS){
  const a=asset(p.kind,p.x,p.z,p.rotation);a.name=`decoration-${p.kind}`;
  Object.assign(a.userData,{role:'static-decoration',tracked:false,roomId:p.roomId,provenance:DECORATION_PROVENANCE});
  a.updateMatrixWorld(true);const bounds=new THREE.Box3().setFromObject(a),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
  // Include wall-mounted case footprint too: walking underneath would intersect a person's torso.
  barrier(center.x,center.z,size.x,size.z);
 }
 root.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
 function setCutaway(on){for(const w of walls)w.scale.y=on?.38:1;for(const c of ceilings)c.visible=!on;}
 setCutaway(true);
 return {root,walls,ceilings,obstacles,locationObjects,assetInstances,setCutaway};
}
