// Mutation inventory for the SV-027 clearance-evidence wiring. NOT a test and not part of any suite: run it by hand.
//   node apps/web/requests/mutation-check.mjs
// It breaks client.js / view.js on purpose, one change at a time, runs apps/web/tests/request-lifecycle.test.mjs, and reports whether the
// tests noticed. A mutation that no test catches is a gap (exit 1). Files are restored afterwards and verified byte for byte.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const here=dirname(fileURLToPath(import.meta.url)),test=join(here,'../tests/request-lifecycle.test.mjs');
const M=[
  ['client.js','the Idempotency-Key header is not forwarded',"{method, body, signal, ...(headers && {headers})}","{method, body, signal}"],
  ['client.js','an uncertain clearance cannot be retried',"['lifecycle','claim','clearWithEvidence'].includes(frozen.kind)","['lifecycle','claim'].includes(frozen.kind)"],
  ['client.js','a role refusal wipes the screen as if access were lost',"if (access(error) && !(frozen.kind === 'clearWithEvidence' && isRoleRefusal(error)))","if (access(error))"],
  ['client.js','evidence is sent without local validation',"try { return validateClearanceInput({schemaVersion: 1, evidence}, {now}); }","try { return {schemaVersion: 1, evidence}; }"],
  ['client.js','every attempt reuses one key',"args:[holdId,body,key()]","args:[holdId,body,'fixed-key']"],
  ['client.js','a response that is not labelled current is shown as current',"stackBasis: result.summaryBasis === 'current' ? 'current' : 'unlabelled',","stackBasis: 'current',"],
  ['client.js','reset and access loss keep the last clearance',"retryable:false, clearIssue:null, lastClearance:null});","retryable:false, clearIssue:null});"],
  ['client.js','an idempotency conflict is described as a plain conflict',"if (status === 409 && code === 'idempotency_conflict')","if (false)"],
  ['client.js','a missing rule is described as a role refusal',"if (status === 422 && code === 'no_clearance_rule')","if (false)"],
  ['view.js','the evidence form is shown even where the contract does not permit it',"if (!permitted) return legacy;",""],
  ['view.js','recorded evidence is written unescaped',"reference ${label(e.reference)}; observed at ${label(e.observedAt)} (as asserted by the clearer)","reference ${e.reference}; observed at ${label(e.observedAt)} (as asserted by the clearer)"],
  ['view.js','a legacy clearance is not labelled as having no additional evidence',"cleared without additional evidence (legacy clearance: only actor and time are recorded)","cleared"],
  ['view.js','a clearance missing from the response is not labelled as unreported',"' · clearance evidence is not reported by this response'","''"],
  ['view.js','the inline validation error is not shown',"${err?`<p class=\"field-error\" id=\"evidence-error-${id}\" role=\"alert\">${esc(err.message)}</p>`:''}",""],
  ['view.js','the invalid field is not marked',"` aria-invalid=\"true\" aria-describedby=\"evidence-error-${id}\"`","''"],
  ['view.js','the stack is not labelled as current state',"This is the current state when the server answered, not part of the receipt.","This is the list."],
  ['view.js','the legacy button loses its label',"' without evidence (legacy)'","''"],
  // SV-035: instance ownership and capability controls
  // dispose() has two overlapping protections (idempotent + ownership). Each alone is covered by the other, so the single changes are
  // EXPECTED to survive ('layer'); the combined change must be caught.
  ['view.js','dispose is not idempotent (ownership check kept)',"dispose(){if(disposed)return;   // idempotent: a repeated call is a no-op\n    disposed=true;","dispose(){\n    disposed=true;",'layer'],
  ['view.js','dispose empties a root it no longer owns (idempotence kept)',"if(mounts.get(root)===handle){root.replaceChildren();mounts.delete(root);}","root.replaceChildren();mounts.delete(root);",'layer'],
  ['view.js','dispose is neither idempotent nor ownership-aware',[["dispose(){if(disposed)return;   // idempotent: a repeated call is a no-op\n    disposed=true;","dispose(){\n    disposed=true;"],["if(mounts.get(root)===handle){root.replaceChildren();mounts.delete(root);}","root.replaceChildren();mounts.delete(root);"]],null],
  ['view.js','a stale resetAccess handle clears a newer mount',"if(disposed||mounts.get(root)!==handle)return;","if(false)return;"],
  ['view.js','a stale resetAccess handle is only ignored when disposed (a replaced handle is always disposed, so this is equivalent)',"if(disposed||mounts.get(root)!==handle)return;","if(disposed)return;",'layer'],
  ['view.js','clearance is offered whatever the advertised capability',"const clearanceCapable = () => permissions.includes('inventory:read') || permissions.includes('equipment:write');","const clearanceCapable = () => true;"],
  ['view.js','clearance needs inventory:read only',"permissions.includes('inventory:read') || permissions.includes('equipment:write');","permissions.includes('inventory:read');"],
  ['view.js','clearance needs equipment:write only',"permissions.includes('inventory:read') || permissions.includes('equipment:write');","permissions.includes('equipment:write');"],
  ['view.js','the evidence form is shown without the capability',"const permitted = clearanceCapable() && canClear(h, role, state.rules);","const permitted = canClear(h, role, state.rules);"],
  ['view.js','a read-only view still submits evidence',"if (!clearableHold(holdId)) return;   // read-only or not the configured role: send nothing, invent no error",""],
  ['view.js','a read-only view still sends the legacy clear',"if(b.dataset.clear){ if(clearableHold(b.dataset.clear)) run(()=>session.clear(b.dataset.clear)); }","if(b.dataset.clear){ run(()=>session.clear(b.dataset.clear)); }"],
  ['view.js','the legacy button ignores the capability when drawn',"const off = state.busy || state.uncertain || !clearanceCapable() || !canClear(h, role, state.rules)","const off = state.busy || state.uncertain || !canClear(h, role, state.rules)"],
];
const files=[...new Set(M.map(m=>m[0]))],orig=Object.fromEntries(files.map(f=>[f,readFileSync(join(here,f),'utf8')]));
const run=()=>spawnSync(process.execPath,['--test',test],{encoding:'utf8'});
const num=(out,key)=>Number((new RegExp(`^ℹ ${key} (\\d+)`,'m').exec(out)||[])[1]??NaN);
const base=run();console.log(`baseline: ${num(base.stdout,'pass')} pass, ${num(base.stdout,'fail')} fail, ${num(base.stdout,'skipped')} skipped`);
if(num(base.stdout,'fail')!==0){console.error('The tests must pass before mutating. Stopping.');process.exit(2);}
let gaps=0;
try{
  for(const [file,name,from,to,flag] of M){
    const edits=Array.isArray(from)?from:[[from,to]];
    let text=orig[file],ok=true;
    for(const [a,b] of edits){if(!text.includes(a)){ok=false;break;}text=text.replace(a,b);}
    if(!ok){console.log(`NOT APPLICABLE  ${name}  (source changed: update this inventory)`);gaps++;continue;}
    writeFileSync(join(here,file),text);const out=run();writeFileSync(join(here,file),orig[file]);
    const failed=num(out.stdout,'fail'),caught=failed>0||out.status!==0;
    if(!caught&&flag!=='layer')gaps++;
    console.log(`${caught?'caught  ':flag==='layer'?'survived (expected: overlapping layer)':'SURVIVED'}  ${name}  (${Number.isNaN(failed)?'would not run':failed+' failing'})`);
  }
}finally{for(const f of files)writeFileSync(join(here,f),orig[f]);}
for(const f of files)if(readFileSync(join(here,f),'utf8')!==orig[f]){console.error(`NOT RESTORED: ${f}`);process.exit(3);}
const byDesign=M.filter(x=>x[4]==='layer').length;
console.log(gaps?`${gaps} mutation(s) not caught: the tests have a gap.`:`${M.length-byDesign} of ${M.length} mutations caught; the other ${byDesign} survive by design (an overlapping protection covers them, and the combined change is caught). Files restored.`);
process.exit(gaps?1:0);
