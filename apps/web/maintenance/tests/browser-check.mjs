// Offline real-browser QA of the scoped module. No API host, loopback listener or shared-app reachability claim.
import {readFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {mountMaintenance} from '../panel.js';
const require=createRequire(new URL('../../../../services/api/maintenance/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8').replace(/<link[^>]+>/,'').replace(/<script type="module">[\s\S]*?<\/script>/,'');
const css=readFileSync(new URL('../style.css',import.meta.url),'utf8'),axe=readFileSync(require.resolve('axe-core/axe.min.js'),'utf8');
const evidence=fileURLToPath(new URL('../evidence/',import.meta.url));mkdirSync(evidence,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH??'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',args:['--disable-background-networking','--no-first-run']});
try{
 const context=await browser.newContext({offline:true,viewport:{width:1440,height:1100},reducedMotion:'reduce'}),page=await context.newPage();
 page.setDefaultTimeout(10000);
 const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
 await page.setContent(html);await page.addStyleTag({content:css});await page.addScriptTag({content:`window.mountMaintenance=${mountMaintenance.toString()}`});
 await page.evaluate(()=>{
  document.querySelector('#connect').hidden=true;document.querySelector('#disconnect').hidden=false;
  let version=1;
  window.panel=window.mountMaintenance(document.querySelector('#maintenance'),{keyFactory:()=>`offline-${version}`,api:{
   list:async({view})=>({items:[{id:'SYN-001',name:'Synthetic equipment monitor',status:view==='cleaning'?'cleaning':'maintenance',version,locationId:'synthetic-store',lastVerified:null,provenance:'synthetic-fixture'}],nextCursor:null}),
   service:async()=>({record:{id:'SYN-001',status:'maintenance',version:++version},replayed:false}),
   history:async()=>({items:[{at:'2026-11-06T00:00:00Z',actor:'synthetic-operator',before:{status:'maintenance'},after:{status:'maintenance',note:'Synthetic service step. Remains unavailable.'}}],nextCursor:null})
  }});
 });
 await page.getByRole('button',{name:'Save service entry',exact:true}).waitFor();
 await page.locator('[data-search] select').selectOption('maintenance');await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByText('1 loaded.',{exact:true}).waitFor();
 await page.getByLabel('Service note (no patient information)').fill('Synthetic inspection complete; equipment remains unavailable.');
 await page.getByRole('button',{name:'Load history',exact:true}).click();await page.getByText('History loaded.',{exact:true}).waitFor();
 const note=page.getByLabel('Service note (no patient information)');await note.focus();await page.keyboard.press('Tab');
 assert.equal(await page.getByRole('button',{name:'Save service entry',exact:true}).evaluate(el=>el===document.activeElement),true,'native keyboard order reaches save');
 await page.keyboard.press('Enter');await page.getByText('Service entry saved. Current state refreshed; unavailable status is preserved.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Save service entry',exact:true}).evaluate(el=>el===document.activeElement),true,'save retains keyboard focus');
 assert.match(await page.locator('[data-detail]').innerText(),/maintenance/);
 await page.getByRole('button',{name:'Load history',exact:true}).click();await page.getByText('History loaded.',{exact:true}).waitFor();await page.getByRole('button',{name:'Save service entry',exact:true}).focus();
 await page.addScriptTag({content:axe});
 for(const [name,width,height] of [['desktop',1440,1100],['narrow',390,844]]){
  await page.setViewportSize({width,height});
  const overflow=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>window.innerWidth).map(el=>({tag:el.tagName,text:el.textContent.slice(0,80),width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right})));assert.deepEqual(overflow,[],`${name}: no horizontal overflow`);
  const results=await page.evaluate(async()=>window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));
  assert.deepEqual(results.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)})),[],`${name}: axe violations`);
  await page.screenshot({path:`${evidence}/${name}.png`,fullPage:true});console.log(`${name}: axe WCAG A/AA passed; no horizontal overflow; screenshot saved`);
 }
 // Bundle the actual adapter and existing domain validator into the offline page, without an HTTP host.
 const contracts=readFileSync(new URL('../../../../packages/domain/contracts.js',import.meta.url),'utf8').replace(/export /g,'');
 const adapter=readFileSync(new URL('../api.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'').replace(/export /g,'');
 await page.addScriptTag({content:`${contracts}\n${adapter}\nwindow.createMaintenanceApi=createMaintenanceApi;`});
 for(const status of [401,403])for(const format of ['html','empty']){
  await page.evaluate(({status,format})=>{
   window.panel.close();window.denied=false;
   const record={schemaVersion:1,id:'SYN-001',name:'Synthetic monitor',modelKind:'monitor',locationId:'store',status:'maintenance',version:1,lastVerified:null,lastAdminEditAt:null,provenance:'synthetic-fixture'};
   const api=window.createMaintenanceApi({organizationId:'synthetic',token:'synthetic-session',fetcher:async(url)=>url.includes('/history')?Response.json({items:[{at:'2026-11-06T00:00:00Z',actor:'synthetic',before:{status:'maintenance'},after:{status:'maintenance',note:'Synthetic cached history'}}],nextCursor:null}):window.denied?new Response(format==='html'?'<html>Forbidden</html>':'',{status}):Response.json({items:[record],nextCursor:null})});
   window.panel=window.mountMaintenance(document.querySelector('#maintenance'),{api});
  },{status,format});
  await page.waitForFunction(()=>document.querySelector('[data-items]').options.length===1&&!document.querySelector('[data-refresh]').disabled);
  await note.fill('Synthetic private draft');await page.getByRole('button',{name:'Load history',exact:true}).click();await page.getByText('History loaded.',{exact:true}).waitFor();
  await page.evaluate(async()=>{window.denied=true;await window.panel.refresh();});
  assert.equal(await page.locator('[data-items] option').count(),0);assert.equal(await note.inputValue(),'');assert.equal(await page.locator('[data-events] li').count(),0);
  assert.match(await page.locator('[data-message]').innerText(),status===401?/Session expired/:/cannot perform/);
 }
 for(const status of [401,403,500]){
  const result=await page.evaluate(async(status)=>{
   window.panel.close();let rejectRead,calls=0;
   window.panel=window.mountMaintenance(document.querySelector('#maintenance'),{api:{list:()=>++calls===1?Promise.resolve({items:[],nextCursor:null}):new Promise((resolve,reject)=>{rejectRead=reject;})}});
   await Promise.resolve();const read=window.panel.refresh();window.panel.close();rejectRead(Object.assign(Error('Old read'),{status}));await read;return document.querySelector('#maintenance').children.length;
  },status);assert.equal(result,0);
 }
 assert.deepEqual(pageErrors,[],'no browser unhandled rejection or late DOM exception');
 console.log('Offline Chrome regressions: actual adapter clears cached inventory/draft/history for HTML/empty401/403; late401/403/500 rejection after close has no page errors.');
 console.log('Offline Chrome: native keyboard service save, unavailable status, history, desktop/narrow and reduced-motion checks passed. Shared app/API mounting is unverified.');
 await context.close();
}finally{await browser.close();}
