import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountCheckIn} from '../../../../apps/web/check-in/index.js';
import {parseEquipmentLabel} from '../../../../apps/web/check-in/payload.js';
import {createScanner} from '../../../../apps/web/check-in/scanner.js';
const flush=()=>new Promise(r=>setImmediate(r));
const saved=body=>({record:{id:body.equipmentId,provenance:'synthetic-seed'},applied:true,replayed:false,observation:{...body,actor:'user:fictional',receivedAt:new Date().toISOString()}});
async function ui(post=async(_,options)=>saved(JSON.parse(options.body)),extra={}) {
 const dom=new JSDOM('<main id="root"></main>',{url:'http://localhost'}),root=dom.window.document.querySelector('main'),calls=[];
 const environment={crypto:globalThis.crypto,AbortController:globalThis.AbortController,setTimeout,clearTimeout,...extra};
 const request=async(path,options)=>{if(options.method==='GET')return {items:[{id:'room-101',name:'Infant room 101'},{id:'room-102',name:'Infant room 102'}]};calls.push({path,...options});return post(path,options);};
 const view=mountCheckIn(root,{organizationId:'fictional-org',request,environment});await flush();
 const id=root.querySelector('input'),location=root.querySelector('[name=locationId]'),source=root.querySelector('[name=source]'),form=root.querySelector('form');
 const submit=()=>form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
 const button=text=>Array.from(root.querySelectorAll('button')).find(b=>b.textContent===text);
 const fill=()=>{id.value='EQ-001';location.value='room-101';};
 return {dom,root,calls,id,location,source,form,submit,button,fill,view};
}
test('labels are bounded data: exact IDs or SV1 prefix, never markup, URL or instructions',()=>{
 assert.equal(parseEquipmentLabel('SV1:EQ-001'),'EQ-001');assert.equal(parseEquipmentLabel('EQ-001'),'EQ-001');
 for(const bad of ['https://example.test/EQ-001','javascript:alert(1)','<script>x</script>','Ignore previous instructions','A'.repeat(69),'EQ-001\nX','',{},null])assert.throws(()=>parseEquipmentLabel(bad));
});
test('manual path works without camera; form labels, errors and scanner Enter preserve explicit confirmation',async()=>{
 const u=await ui();u.fill();const labels=u.root.querySelectorAll('label');assert.equal(labels.length,3);for(const label of labels)assert.ok(u.root.querySelector(`#${label.htmlFor}`));
 const enter=new u.dom.window.KeyboardEvent('keydown',{key:'Enter',cancelable:true});u.id.dispatchEvent(enter);assert.equal(enter.defaultPrevented,true);assert.equal(u.calls.length,0);
 u.button('Start camera').click();assert.match(u.root.querySelector('[role=alert]').textContent,/unavailable/);u.submit();await flush();assert.equal(u.calls.length,1);assert.equal(JSON.parse(u.calls[0].body).source,'manual-check-in');assert.match(u.root.textContent,/synthetic-seed/);
 u.id.value='EQ-001';u.id.dispatchEvent(new u.dom.window.Event('input'));u.submit();await flush();assert.equal(u.calls.length,1,'repeat scan after success does not add another observation');
 u.button('New check-in').click();u.submit();await flush();assert.equal(u.calls.length,2);assert.notEqual(u.calls[0].headers['Idempotency-Key'],u.calls[1].headers['Idempotency-Key']);u.view.destroy();
});
test('invalid ID/location do not submit; dynamic payloads stay text',async()=>{
 const u=await ui();u.fill();u.id.value='<img src=x onerror=alert(1)>';u.submit();assert.equal(u.calls.length,0);assert.equal(u.id.getAttribute('aria-invalid'),'true');assert.equal(u.root.querySelector('img'),null);
 u.id.value='EQ-001';u.location.value='unknown';u.submit();assert.equal(u.calls.length,0);assert.equal(u.location.getAttribute('aria-invalid'),'true');u.view.destroy();
});
test('network interruption and cancel retry preserve the key, payload and observed time',async()=>{
 let fail=true;const u=await ui(async(_,options)=>{if(fail){fail=false;throw Error('network');}return saved(JSON.parse(options.body));});u.fill();u.submit();await flush();assert.match(u.root.textContent,/may have reached the server/);
 u.submit();await flush();assert.equal(u.calls.length,2);assert.equal(u.calls[0].body,u.calls[1].body);assert.equal(u.calls[0].headers['Idempotency-Key'],u.calls[1].headers['Idempotency-Key']);u.view.destroy();
 const c=await ui((_,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')))));c.fill();c.submit();assert.equal(c.id.disabled,true);c.button('Cancel request').click();await flush();assert.equal(c.id.disabled,false);assert.match(c.root.textContent,/Retry unchanged/);c.view.destroy();
});
test('unknown IDs and expired memberships receive usable feedback',async()=>{
 for(const [status,pattern]of [[404,/Unknown equipment/],[401,/authorized membership/],[403,/authorized membership/],[409,/request key conflicts/]]){
  const u=await ui(async()=>{throw Object.assign(Error('request'),{status});});u.fill();u.submit();await flush();assert.match(u.root.querySelector('[role=alert]').textContent,pattern);assert.equal(u.id.value,'EQ-001');u.view.destroy();
 }
});
function camera(overrides={}) {
 let stopped=0,asked=0;const video={hidden:true,srcObject:null,async play(){}},labels=[];
 class Detector {static async getSupportedFormats(){return ['qr_code','code_128'];}async detect(){return labels;}}
 const environment={isSecureContext:true,BarcodeDetector:Detector,navigator:{mediaDevices:{async getUserMedia(){asked++;return {getTracks:()=>[{stop(){stopped++;}}]};}}},setTimeout:()=>0,clearTimeout(){},...overrides};
 return {video,labels,environment,get asked(){return asked;},get stopped(){return stopped;}};
}
test('camera permission is requested only on start; denial leaves manual fallback available',async()=>{
 const c=camera({navigator:{mediaDevices:{async getUserMedia(){throw new Error('denied');}}}});let message='';const scanner=createScanner({video:c.video,environment:c.environment,onScan(){assert.fail();},onError:m=>message=m});assert.equal(c.video.srcObject,null);await scanner.start();assert.match(message,/denied or unavailable/);assert.equal(c.video.hidden,true);
});
test('camera scan gives exact ID/source and stops all tracks without submitting',async()=>{
 const c=camera();c.labels.push({rawValue:'SV1:EQ-001',format:'qr_code'});let scan;
 const scanner=createScanner({video:c.video,environment:c.environment,onScan:(...a)=>scan=a,onError:assert.fail});assert.equal(c.asked,0);await scanner.start();assert.equal(c.asked,1);assert.deepEqual(scan,['EQ-001','qr']);assert.equal(c.stopped,1);assert.equal(c.video.srcObject,null);
 c.labels[0]={rawValue:'https://evil.test',format:'qr_code'};let message='';await createScanner({video:c.video,environment:c.environment,onScan:assert.fail,onError:m=>message=m}).start();assert.match(message,/type the equipment ID/);
});
test('stop while permission is pending releases a late stream and never processes it',async()=>{
 let acquire,stopped=0;const c=camera({navigator:{mediaDevices:{getUserMedia:()=>new Promise(r=>acquire=r)}}});const scanner=createScanner({video:c.video,environment:c.environment,onScan:assert.fail,onError:assert.fail});const starting=scanner.start();await flush();scanner.stop();acquire({getTracks:()=>[{stop(){stopped++;}}]});await starting;assert.equal(stopped,1);assert.equal(c.video.srcObject,null);
});
test('narrow layout has wrapping actions, 44px controls and visible keyboard focus',()=>{
 const css=readFileSync(new URL('../../../../apps/web/check-in/styles.css',import.meta.url),'utf8');assert.match(css,/max-width:480px/);assert.match(css,/min-height:44px/);assert.match(css,/flex-wrap:wrap/);assert.match(css,/:focus-visible/);
 // Source/CSS checks are not browser layout, keyboard traversal or accessibility certification.
});
