// Local web development only: proxy the existing API; do not issue identities or add auth.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export function createWebHandler({apiOrigin,apiHandler}={}){
 if(apiHandler!==undefined&&typeof apiHandler!=='function')throw Error('Injected API handler must be a function');
 const upstream=apiOrigin?new URL(apiOrigin):null;
 if(upstream&&(!['127.0.0.1','localhost','[::1]'].includes(upstream.hostname)||upstream.protocol!=='http:'||upstream.username||upstream.password||upstream.pathname!=='/'||upstream.search||upstream.hash))throw Error('Local API_ORIGIN must be a loopback HTTP origin without credentials or a path');
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.glb':'model/gltf-binary'};
 return async(req,res)=>{
  let url;try{url=new URL(req.url,'http://localhost');}catch{res.writeHead(400,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({error:'invalid_request'}));return;}
  if(url.pathname.startsWith('/organizations/')){
   if(apiHandler){try{return await apiHandler(req,res);}catch{if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({error:'internal_error'}));else res.destroy?.();return;}}
   if(!upstream){res.writeHead(503,{'Content-Type':'application/json'}).end(JSON.stringify({error:'api_not_configured'}));return;}
   // Streaming proxy keeps the existing handler's wire contract and bearer boundary intact.
   const headers={host:upstream.host};
   for(const key of ['authorization','content-type','idempotency-key','x-correlation-id'])if(req.headers[key])headers[key]=req.headers[key];
   const proxy=http.request(new URL(url.pathname+url.search,upstream),{method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
   proxy.setTimeout(15000,()=>proxy.destroy());
   proxy.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'}).end(JSON.stringify({error:'api_unavailable'}));else res.destroy();});
   res.on('close',()=>{if(!res.writableEnded)proxy.destroy();});req.pipe(proxy);return;
  }
  try{
   if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405).end();return;}
   const path=decodeURIComponent(url.pathname);let base,relative;
   if(path.startsWith('/ward/')){base=resolve(root,'packages/scene/viewer');relative=path.slice(6)||'index.html';}
   else if(path.startsWith('/packages/domain/')){base=resolve(root,'packages/domain');relative=path.slice(17);}
   else{base=resolve(root,'apps/web');relative=path==='/'||['/maintenance','/maintenance/'].includes(path)?'index.html':path.slice(1);}
   const file=resolve(base,relative);
   const maintenancePublic=['api.js','panel.js','style.css'].map(name=>resolve(root,'apps/web/maintenance',name));
   if(!file.startsWith(base+sep)||(!file.startsWith(resolve(root,'apps/web/src')+sep)&&base===resolve(root,'apps/web')&&file!==resolve(base,'index.html')&&!maintenancePublic.includes(file)))throw Error('Not a public asset');
   const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store'}).end(req.method==='HEAD'?undefined:data);
  }catch{res.writeHead(404).end('Not found');}
 };
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 http.createServer(createWebHandler({apiOrigin:process.env.API_ORIGIN})).listen(Number(process.env.PORT||4180),'127.0.0.1',()=>console.log('Supply Vanguard local web client ready (synthetic development sessions only).'));
}
