// SYNTHETIC VISUAL FIXTURE ONLY. This adapter is not auth, a ledger, or native concurrency evidence.
import {readFileSync,writeFileSync} from 'node:fs';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const view=read('../../../../apps/web/supplies/view.mjs').replace('export function mountSupplies','function mountSupplies');
const css=read('../../../../apps/web/src/styles.css')+'\n'+read('../../../../apps/web/supplies/supplies.css');
const fixture=`
const b={id:'00000000-0000-4000-8000-000000000001',name:'Synthetic test supply',code:'SYN-TEST-BIN',unit:'ml',quantity:'1.125',stock_version:1,par_quantity:'5.125',par_version:1,low_par:true};
let t={id:'00000000-0000-4000-8000-000000000002',bin_id:b.id,name:b.name,code:b.code,unit:b.unit,quantity:b.quantity,par_quantity:b.par_quantity,stock_version:1,version:0,status:'open',assigned_to_me:false,low_par:true};
const client={listBins:async()=>({items:[b],nextCursor:null,canWrite:true}),listTasks:async()=>({items:t?[t]:[],nextCursor:null}),history:async()=>({items:[],nextCursor:null}),command:async(op,q)=>{
 if(op==='assign'){t={...t,status:'assigned',version:1,assigned_to_me:true};return {replayed:false};}
 if(op==='complete'){t=null;return {replayed:false};}
 return {replayed:false,created:false};
}};
mountSupplies(document.getElementById('supplies'),{client,synthetic:true});
document.getElementById('narrow').addEventListener('click',()=>{document.body.style.maxWidth='390px';document.body.style.margin='auto';document.getElementById('layout').textContent='390 px test frame';});
`;
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SV-010 synthetic visual fixture</title><style>${css}</style></head><body><a class="skip" href="#main">Skip to supply replenishment</a><header class="site-header"><a class="brand" href="#main">Supply Vanguard</a><p class="descriptor">Synthetic visual fixture only</p><button id="narrow">Show phone test frame</button><span id="layout">Desktop test frame</span></header><main id="main"><div id="supplies"></div></main><footer class="site-footer">Synthetic visual fixture. No network, real inventory, or production session.</footer><script>${view}\n${fixture}</script></body></html>`;
const output=new URL('./synthetic-preview.html',import.meta.url);
writeFileSync(output,html);
console.log(output.pathname);
