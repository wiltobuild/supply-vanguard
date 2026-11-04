export const LIMITS={minX:-11.32,maxX:11.32,minZ:-6.82,maxZ:6.82};
export function isWalkable(x,z,obstacles,radius=.24){
 if(x<LIMITS.minX+radius||x>LIMITS.maxX-radius||z<LIMITS.minZ+radius||z>LIMITS.maxZ-radius)return false;
 return !obstacles.some(o=>x>o.x-o.w/2-radius&&x<o.x+o.w/2+radius&&z>o.z-o.d/2-radius&&z<o.z+o.d/2+radius);
}
export function findPath(start,end,obstacles){
 const step=.25,minX=-11,minZ=-6.5,nx=89,nz=53;
 const pos=(x,z)=>[minX+x*step,minZ+z*step];
 function closest(p){let best=null,dist=Infinity;for(let x=0;x<nx;x++)for(let z=0;z<nz;z++){let w=pos(x,z),d=(w[0]-p[0])**2+(w[1]-p[1])**2;if(d<dist&&isWalkable(...w,obstacles)){best=[x,z];dist=d;}}return best;}
 const a=closest(start),b=closest(end);if(!a||!b)return [];
 const key=(x,z)=>z*nx+x,s=key(...a),goal=key(...b),open=[s],came=new Map(),cost=new Map([[s,0]]);
 const heuristic=k=>Math.abs(k%nx-b[0])+Math.abs(Math.floor(k/nx)-b[1]);
 let guard=0;
 while(open.length&&guard++<10000){open.sort((a,b)=>(cost.get(a)+heuristic(a))-(cost.get(b)+heuristic(b)));const k=open.shift();if(k===goal){const chain=[];let q=k;while(q!==undefined){chain.push(pos(q%nx,Math.floor(q/nx)));q=came.get(q);}chain.reverse();if(isWalkable(...end,obstacles))chain.push(end);return chain;}
 const x=k%nx,z=Math.floor(k/nx);for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1]]){const xx=x+dx,zz=z+dz;if(xx<0||xx>=nx||zz<0||zz>=nz||!isWalkable(...pos(xx,zz),obstacles))continue;const kk=key(xx,zz),cc=cost.get(k)+1;if(cc<(cost.get(kk)??Infinity)){came.set(kk,k);cost.set(kk,cc);if(!open.includes(kk))open.push(kk);}}
 }return [];
}
