import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSaved,sanitizeEvent,filterEquipment,describeFreshness,nextToReview,summarize,latestUpdate,webglAvailable} from '../apps/web/src/lib.js';
import {validateEquipment,isStale} from '../packages/domain/equipment.js';
import {roomIds,seedEquipment} from '../packages/domain/seed.js';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const ctx={validate:validateEquipment,roomIds,expectedCount:8};
test('persisted data: unreadable, wrong-shaped or invalid saves fall back with a visible notice',()=>{
 assert.deepEqual(parseSaved(null,ctx),{items:null,events:[],notice:null});
 for(const bad of ['{not json','null','{"items":[]}',JSON.stringify({items:seedEquipment().slice(1)}),JSON.stringify({items:[...seedEquipment().slice(1),seedEquipment()[1]]}),JSON.stringify({items:seedEquipment().map(i=>({...i,status:'broken'}))})]){
  const r=parseSaved(bad,ctx);assert.equal(r.items,null,bad);assert.match(r.notice,/could not be read/);}
 const ok=parseSaved(JSON.stringify({items:seedEquipment(),events:[]}),ctx);assert.equal(ok.items.length,8);assert.equal(ok.notice,null);
});
test('persisted events are reduced to clipped strings; junk is dropped',()=>{
 const evil='<img src=x onerror=alert(1)>'.repeat(40);
 const e=sanitizeEvent({equipmentId:'EQ-1',actor:evil,at:'t',note:evil,before:{roomId:5},after:{roomId:'room-101',status:'in-use',version:2},extra:{deep:1}});
 assert.ok(e.actor.length<=100&&e.note.length<=500);assert.equal(e.before.roomId,'');assert.equal(e.after.version,2);assert.equal('extra' in e,false);
 assert.equal(sanitizeEvent(null),null);assert.equal(sanitizeEvent('x'),null);assert.equal(sanitizeEvent({}),null);
 const r=parseSaved(JSON.stringify({items:seedEquipment(),events:[{equipmentId:'EQ-1',after:{}},{bogus:true},7,...Array.from({length:150},(_,i)=>({equipmentId:`E${i}`}))]}),ctx);
 assert.equal(r.events.length,100);
});
test('the app never writes data into the page as HTML',()=>{
 const app=read('../apps/web/src/app.js');
 assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(app),false);
 assert.match(app,/textContent|createTextNode/);
});
test('search and filter, freshness and workspace summary reflect real records',()=>{
 const items=seedEquipment();
 assert.equal(filterEquipment(items,'pump').length,2);assert.equal(filterEquipment(items,'ROOM-101').length,1);assert.equal(filterEquipment(items,'  ').length,8);
 assert.equal(filterEquipment(items,'',  'maintenance').length,1);assert.equal(filterEquipment(items,'pump','available').length,1);assert.equal(filterEquipment(items,'nothing').length,0);
 assert.deepEqual(describeFreshness(items[0],isStale),{state:'unverified',text:'Not yet verified'});
 const now=new Date().toISOString(),old=new Date(Date.now()-3600e3).toISOString();
 assert.equal(describeFreshness({...items[0],lastSeenAt:now},isStale).state,'fresh');assert.equal(describeFreshness({...items[0],lastSeenAt:old},isStale).state,'stale');
 assert.equal(nextToReview(items,isStale).id,'EQ-001');assert.equal(nextToReview(items.map(i=>({...i,lastSeenAt:now})),isStale),null);
 assert.deepEqual(summarize(items,isStale),{total:8,available:4,needsVerification:8});
 assert.equal(latestUpdate(items),null);assert.equal(latestUpdate([{lastSeenAt:old},{lastSeenAt:now}]).toISOString(),now);
});
test('WebGL detection handles missing, throwing and working contexts',()=>{
 assert.equal(webglAvailable(()=>({getContext:()=>null})),false);
 assert.equal(webglAvailable(()=>{throw new Error('no canvas');}),false);
 assert.equal(webglAvailable(()=>({getContext:t=>t==='webgl'?{}:null})),true);
});
// WCAG contrast from the tokens actually in styles.css.
const lum=hex=>{const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c<=.03928?c/12.92:((c+.055)/1.055)**2.4);return .2126*r+.7152*g+.0722*b;};
const ratio=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+.05)/(y+.05);};
test('design tokens meet WCAG AA text contrast on the surfaces they sit on',()=>{
 const css=read('../apps/web/src/styles.css'),t=Object.fromEntries([...css.matchAll(/--([\w-]+):(#[0-9a-f]{6})/gi)].map(m=>[m[1],m[2]]));
 const pairs=[['ink','white'],['text-2','white'],['text-2','mint'],['text-2','blue'],['text-2','blush'],['ink','coral'],['ink','mint'],['ink','blue'],['ink','blush'],['ok','white'],['busy','white'],['clean','white'],['fix','white'],['gone','white'],['danger','white'],['clean','blue'],['ok','blue'],['danger','blue']];
 for(const [fg,bg] of pairs){assert.ok(t[fg]&&t[bg],`${fg}/${bg} token exists`);assert.ok(ratio(t[fg],t[bg])>=4.5,`${fg} on ${bg}: ${ratio(t[fg],t[bg]).toFixed(2)}`);}
 // The reference's white text on coral does not pass, which is why buttons use ink on coral.
 assert.ok(ratio(t.white,t.coral)<4.5);
});
test('shell has the accessibility basics: language, skip link, labelled nav, reduced-motion rule, focus ring, 44px targets',()=>{
 const html=read('../apps/web/index.html'),css=read('../apps/web/src/styles.css');
 assert.match(html,/<html lang="en">/);assert.match(html,/class="skip" href="#main"/);assert.match(html,/<nav aria-label="Main"/);assert.match(html,/<noscript>/);
 assert.match(css,/prefers-reduced-motion:reduce/);assert.match(css,/:focus-visible/);assert.match(css,/--touch:44px/);
});
