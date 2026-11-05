import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
if(!process.argv[2])throw Error('Pass the isolated QA toolchain directory containing playwright');
const require=createRequire(pathToFileURL(resolve(process.argv[2],'package.json')));
const {chromium}=require('playwright');
const base=process.argv[3]||'http://127.0.0.1:4180';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const output=resolve(import.meta.dirname,'../packages/scene/verification/SV-024')+'/';
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-webgl','--ignore-gpu-blocklist']});
try{
const page=await browser.newPage({viewport:{width:1200,height:800},deviceScaleFactor:.4});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('favicon.ico'))errors.push(`${r.status()} ${r.url()}`);});
await page.goto(base+'/ward/additional-gallery.html');
await page.waitForFunction(()=>document.querySelector('#status')?.textContent.startsWith('15 models rendered'));
await page.waitForFunction(()=>document.querySelectorAll('.model img').length===15&&[...document.querySelectorAll('.model img')].every(i=>i.complete));
assert.equal(await page.locator('canvas').count(),0,'gallery disposes its single offscreen renderer');
await page.goto(base+'/ward/');await page.waitForFunction(()=>window.SupplySentry);
const scene=await page.evaluate(()=>{const a=[];window.SupplySentry.getScene().traverse(o=>{if(o.userData.role==='static-decoration')a.push({name:o.name,tracked:o.userData.tracked,roomId:o.userData.roomId});});return a;});assert.equal(scene.length,15);
await page.click('#nav-assets');assert.equal(await page.locator('[data-inspect]').count(),25);
const catalogText=await page.locator('#inspector').innerText();assert.ok(!catalogText.includes('undefined'));assert.ok(catalogText.includes('static decoration'));
const kinds=await page.locator('[data-inspect]').evaluateAll(nodes=>nodes.slice(10).map(n=>n.dataset.inspect));
for(const kind of kinds){await page.click(`[data-inspect="${kind}"]`);assert.equal(await page.evaluate(()=>window.SupplySentry.getViewState().assetKind),kind);const r=await page.request.get(`${base}/ward/assets/${kind}.glb`);assert.ok(r.ok());}
await page.click('#back-to-ward');
await page.evaluate(()=>{window.__routeDone=[];document.addEventListener('supply-sentry:navigation-complete',e=>window.__routeDone.push(e.detail));window.SupplySentry.navigateToLocation('EQ-A');});
await page.waitForFunction(()=>window.__routeDone.length>0,{},{timeout:90000});
const route=await page.evaluate(()=>({events:window.__routeDone,state:window.SupplySentry.getViewState()}));
await page.screenshot({path:output+'equipment-store-walk.png',scale:'css'});
await page.click('#overview');await page.click('[data-room="equipment-store"]');await page.waitForTimeout(1000);await page.screenshot({path:output+'equipment-store.png',scale:'css'});
assert.deepEqual(errors,[]);
const fallback=await browser.newPage();await fallback.addInitScript(()=>{const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(type==='webgl'||type==='webgl2'||type==='experimental-webgl')return null;return get.call(this,type,...args);};});
await fallback.goto(base+'/ward/additional-gallery.html');await fallback.waitForFunction(()=>document.querySelector('#status').textContent.includes('unavailable'));assert.equal(await fallback.locator('a[download]').count(),15);await fallback.close();
writeFileSync(output+'browser-validation.json',JSON.stringify({browser:await browser.version(),viewport:{width:1200,height:800},deviceScaleFactor:.4,renderer:'SwiftShader software rendering; not a performance benchmark',webgl:true,catalogEntries:25,newModelsInspected:kinds,decorationInstances:scene,completedRoute:route,galleryFallbackDownloads:15,errors},null,2)+'\n');
console.log('Browser QA passed; screenshots and report saved.');
}finally{await browser.close();}
