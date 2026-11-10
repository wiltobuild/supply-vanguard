// Mutation inventory for the SV-010 lifecycle repairs. NOT a test and not part of any suite: run it by hand.
//   node services/api/replenishment/tests/lifecycle-mutations.mjs
// It breaks apps/web/supplies/view.mjs on purpose, one change at a time, runs lifecycle.test.mjs, and reports whether the tests noticed.
// A mutation that no test catches is a gap (exit 1). The file is restored afterwards and verified byte for byte.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const here=dirname(fileURLToPath(import.meta.url)),view=join(here,'../../../../apps/web/supplies/view.mjs'),test=join(here,'lifecycle.test.mjs');
// Each mutation is a list of [from, to] edits applied together. `layer: true` marks a change to ONE of two overlapping protections: it is expected
// to survive on its own, because the other layer still covers the hole (the combined mutations below prove each pair is covered).
const SUBMIT_GUARD=["        await load(true);\n        if (disposed) return;   // destroyed (or replaced) while the refresh ran: touch nothing, least of all focus\n","        await load(true);\n"];
const SUBMIT_SCOPE=["const focus = binsArea.querySelector(`[id=\"supply-${identity.binId}\"]`) || refresh;","const focus = doc.getElementById(`supply-${identity.binId}`) || refresh;"];
const RETRY_GUARD=["          if(disposed)return;   // destroyed (or replaced) while the refresh ran: touch nothing, least of all focus\n",""];
const RETRY_SCOPE=["(binsArea.querySelector(`[id=\"supply-${input.binId}\"]`)||refresh).focus();","(doc.getElementById(`supply-${input.binId}`)||refresh).focus();"];
const MUTATIONS=[
  {name:'submit path: no disposed check AND focus found in the whole document',edits:[SUBMIT_GUARD,SUBMIT_SCOPE]},
  {name:'retry path: no disposed check AND focus found in the whole document',edits:[RETRY_GUARD,RETRY_SCOPE]},
  {name:'submit path: focus found in the whole document (guard kept)',edits:[SUBMIT_SCOPE]},
  {name:'retry path: focus found in the whole document (guard kept)',edits:[RETRY_SCOPE]},
  {name:'submit path: no disposed check (scoped lookup kept)',edits:[SUBMIT_GUARD],layer:true},
  {name:'retry path: no disposed check (scoped lookup kept)',edits:[RETRY_GUARD],layer:true},
  {name:'destroy clears the whole shared root',edits:[['    for(const node of own)if(node.parentNode===root)root.removeChild(node);','    root.replaceChildren();']]},
  {name:'destroy leaves the root styling behind',edits:[["    if(!root.firstChild)root.classList.remove('supplies');",'']]},
  {name:'destroy removes the styling even for a newer mount',edits:[["    if(!root.firstChild)root.classList.remove('supplies');","    root.classList.remove('supplies');"]]},
];
const run=()=>spawnSync(process.execPath,['--test',test],{encoding:'utf8'});
const num=(out,key)=>Number((new RegExp(`^ℹ ${key} (\\d+)`,'m').exec(out)||[])[1]??NaN);
const original=readFileSync(view,'utf8');
const base=run();console.log(`baseline: ${num(base.stdout,'pass')} pass, ${num(base.stdout,'fail')} fail, ${num(base.stdout,'skipped')} skipped`);
if(num(base.stdout,'fail')!==0){console.error('The tests must pass before mutating. Stopping.');process.exit(2);}
let gaps=0;
try{
  for(const {name,edits,layer} of MUTATIONS){
    let text=original,ok=true;
    for(const [from,to] of edits){if(!text.includes(from)){ok=false;break;}text=text.replace(from,to);}
    if(!ok){console.log(`NOT APPLICABLE  ${name}  (source text changed: update this inventory)`);gaps++;continue;}
    writeFileSync(view,text);const out=run();writeFileSync(view,original);
    const failed=num(out.stdout,'fail'),caught=failed>0||out.status!==0;
    const verdict=caught?'caught   ':layer?'survived (expected: overlapping layer)':'SURVIVED';
    if(!caught&&!layer)gaps++;
    console.log(`${verdict}  ${name}  (${Number.isNaN(failed)?'would not run':failed+' failing'})`);
  }
}finally{writeFileSync(view,original);}
if(readFileSync(view,'utf8')!==original){console.error('NOT RESTORED: view.mjs');process.exit(3);}
console.log(gaps?`${gaps} mutation(s) not caught: the tests have a gap.`:'Every mutation that should be caught was caught; view.mjs restored.');
process.exit(gaps?1:0);
