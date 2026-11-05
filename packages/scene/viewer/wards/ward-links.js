// Additive entry links: a ward is selectable only when its real entry document exists.
export const WARD_ROUTES=[{id:'nicu',label:'NICU',href:'/ward/index.html'},{id:'picu',label:'PICU',href:'/ward/wards/picu/index.html'},{id:'pcu',label:'PCU',href:'/ward/wards/pcu/index.html'}];
export async function routeAvailable(route,fetcher=fetch){
 try{const response=await fetcher(route.href,{cache:'no-store'});if(!response.ok)return false;const html=await response.text();return /<html[\s>]/i.test(html)&& (route.id==='nicu'?html.includes('NICU'):html.includes(`data-ward="${route.id}"`));}catch{return false;}
}
export async function mountWardLinks(host){
 const current=host.dataset.wardLinks;const nodes=WARD_ROUTES.map(r=>{const node=document.createElement('span');node.textContent=r.label+(r.id===current?'':' · checking');if(r.id===current)node.setAttribute('aria-current','page');return node;});host.replaceChildren(...nodes);
 await Promise.all(WARD_ROUTES.map(async(r,i)=>{if(r.id===current)return;if(await routeAvailable(r)){const a=document.createElement('a');a.href=r.href;a.textContent=r.label;nodes[i].replaceWith(a);}else nodes[i].textContent=`${r.label} · unavailable`;}));
}
if(typeof document!=='undefined'){
 const style=document.createElement('style');style.textContent='[data-ward-links]{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font:12px Arial,sans-serif}[data-ward-links] a,[data-ward-links] span{padding:10px 12px;border:1px solid #d4dfe4;border-radius:9px;line-height:20px}[data-ward-links] a{color:#194c67;background:#fff;text-decoration:none}[data-ward-links] span{color:#52616c}[data-ward-links] [aria-current]{color:#172531;background:#e6f3fa;font-weight:bold}[data-ward-links] a:focus-visible{outline:3px solid #216b9a;outline-offset:2px}';document.head.append(style);
 document.querySelectorAll('[data-ward-links]').forEach(mountWardLinks);
}
