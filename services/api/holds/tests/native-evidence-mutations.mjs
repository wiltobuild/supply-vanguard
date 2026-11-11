// Mutation inventory for the SV-034 harness, extended by SV-036. NOT a test and not part of any suite: run it by hand.
//   node services/api/holds/tests/native-evidence-mutations.mjs
// It breaks the harness on purpose, one change at a time, runs evidence-native.test.mjs (pure tests with fakes; it never connects), and
// reports whether the tests noticed. A mutation that no test catches is a gap (exit 1). Files are restored and verified byte for byte.
// An entry marked OVERLAP is protected by two layers on purpose (e.g. the verifier is closed by name AND by the leftover sweep): its single change is
// reported as 'survived (expected overlapping layer)' and the combined entry (both layers removed) must be caught.
// Not covered by design: removing waitQueued() is invisible to the in-memory model (it only matters against a real database).
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const here=dirname(fileURLToPath(import.meta.url)),dir=join(here,'native-evidence'),suite=join(here,'evidence-native.test.mjs');
const M=[
  ['runner.mjs','acceptance without every required case',"receipt.accepted=Boolean(receipt.preflight?.passed)&&allRequiredPassed&&","receipt.accepted=Boolean(receipt.preflight?.passed)&&"],
  ['runner.mjs','acceptance with uncertain cleanup',"&&receipt.cleanup.certain&&receipt.cases.every","&&receipt.cases.every"],
  ['runner.mjs','an extra case that did not pass does not block acceptance',"&&receipt.cases.every(c=>c.status===STATUS.PASS);","&&true;"],
  ['runner.mjs','cases run although the preflight failed',"if(!receipt.preflight.passed){receipt.cases=notRun('preflight_failed');return;}","if(false){receipt.cases=notRun('preflight_failed');return;}"],
  ['runner.mjs','a timeout is treated as a pass',"entry.status=STATUS.UNCERTAIN;entry.code='deadline_exceeded';","entry.status=STATUS.PASS;entry.code='deadline_exceeded';"],
  ['runner.mjs','an unexpected error is treated as a pass',"else{entry.status=STATUS.UNCERTAIN;entry.code='harness_error';}","else{entry.status=STATUS.PASS;entry.code='harness_error';}"],
  ['runner.mjs','a dying session is treated as a pass',"else if(e instanceof SessionError){entry.status=STATUS.UNCERTAIN;","else if(e instanceof SessionError){entry.status=STATUS.PASS;"],
  ['runner.mjs','a failed cleanup does not downgrade a pass',"if(entry.status===STATUS.PASS){entry.status=STATUS.UNCERTAIN;entry.code='cleanup_uncertain';}","if(false){entry.status=STATUS.UNCERTAIN;entry.code='cleanup_uncertain';}"],
  ['runner.mjs','open transactions are not rolled back at cleanup',"try{if(s.isOpen()&&!s.isTainted())await s.submit('ROLLBACK;',deadline);}catch{certain=false;}",""],
  ['runner.mjs','owned sessions are not closed at cleanup',"if(!await closeHandle(s))certain=false;",""],
  ['runner.mjs','the fixture is not restored after a control case',"if(controlUsed){try{const r=await withDeadline(control.apply({action:'restore',scope:'all'}),deadline,'control');if(!r||r.ok!==true)certain=false;}catch{certain=false;}}",""],
  ['runner.mjs','the verifier session is left open (named close only; the leftover sweep still closes it)',"if(verifier&&!attempted.has(verifier)&&!await closeHandle(verifier))receipt.cleanup.certain=false;","",'OVERLAP'],
  ['runner.mjs','the verifier session is left open (named close AND leftover sweep removed)',["if(verifier&&!attempted.has(verifier)&&!await closeHandle(verifier))receipt.cleanup.certain=false;","for(const handle of factory.ownedHandles())if(!attempted.has(handle)&&!await closeHandle(handle))receipt.cleanup.certain=false;"],["",""]],
  ['runner.mjs','handles left open are not reported',"if(factory.ownedHandles().length>0)receipt.cleanup.certain=false;",""],
  ['runner.mjs','a missing control still runs the control case',"if(def.usesControl&&!control){receipt.cases.push({name:def.name,status:STATUS.NOT_RUN,code:'fixture_control_unavailable'});continue;}",""],
  ['runner.mjs','a fixture shortage still starts the case',"if(!canSupply(pool,def.needs)){receipt.cases.push({name:def.name,status:STATUS.NOT_RUN,code:'fixture_incomplete'});continue;}",""],
  ['runner.mjs','a failed fixture control is ignored',"if(!res||res.ok!==true)throw new CaseFail('fixture_control_failed');",""],
  ['contract.mjs','a non-loopback host is accepted',"if(!LOOPBACK_HOSTS.includes(r.host))fail('host_not_loopback','runtime.host');",""],
  ['contract.mjs','approval is not required',"if(raw.optIn.approved!==true)fail('opt_in_not_approved','optIn.approved');",""],
  ['contract.mjs','the database need not be bound to the run',"||r.database!==expectedDb)fail('database_not_bound_to_run'","||false)fail('database_not_bound_to_run'"],
  ['contract.mjs','secret-looking fields are accepted',"if(SECRET_FIELD.test(key))fail('secret_field_refused',path);",""],
  ['contract.mjs','the process environment is inherited by sessions',"env:Object.freeze({PGPASSFILE:r.passfile,","env:Object.freeze({...process.env,PGPASSFILE:r.passfile,"],
  ['contract.mjs','a password prompt is possible',"['-X','-q','-w','-At',","['-X','-q','-At',"],
  ['contract.mjs','a relative psql path is accepted',"if(typeof value!=='string'||value.length>260||!/^(\\/|[A-Za-z]:[\\\\/])[A-Za-z0-9_ .\\\\/:~+-]*$/.test(value))fail('path_not_absolute',path);",""],
  ['preflight.mjs','an elevated role is not detected',"check('role_attributes',cells(attrs[0]).every(f),'role_has_elevated_attribute');","check('role_attributes',true,'x');"],
  ['preflight.mjs','forced row-level security is not required',"check('rls_forced',FORCED_RELATIONS.every(n=>byName.has(n)&&t(byName.get(n)[1])&&t(byName.get(n)[2])),'rls_not_enabled_and_forced');","check('rls_forced',true,'x');"],
  ['preflight.mjs','the auth_user exception is not checked',"check('auth_user_exception',byName.has('auth_user')&&t(byName.get('auth_user')[1])&&f(byName.get('auth_user')[2]),'auth_user_exception_not_as_designed');","check('auth_user_exception',true,'x');"],
  ['preflight.mjs','extra evidence privileges are tolerated',"const exact=EVIDENCE_RELATIONS.every(rel=>{const c=byName.get(rel);return Boolean(c)&&t(c[0])&&t(c[1])&&c.slice(2).every(f);});","const exact=true;"],
  ['preflight.mjs','an older evidence function is accepted',"check('evidence_function_is_0003',Boolean(evidenceFn)&&t(evidenceFn[2]),'evidence_function_not_the_corrected_version');","check('evidence_function_is_0003',true,'x');"],
  ['preflight.mjs','membership in an owner role is tolerated',"else check('not_member_of_owner_roles',answer.every(f),'runtime_role_is_member_of_an_owner_role');","else check('not_member_of_owner_roles',true,'x');"],
  ['preflight.mjs','the database name is not verified',"check('database',db===r.database,'wrong_database');","check('database',true,'x');"],
  ['preflight.mjs','the configured rules are not verified',"check('rules',Object.keys(fix.rules).every(k=>got[k]===fix.rules[k])&&Object.keys(got).length===Object.keys(fix.rules).length,'configured_rules_mismatch');","check('rules',true,'x');"],
  ['session.mjs','result data can spoof the end of a statement',"if(line.startsWith(`SVEND ${nonce} `)){","if(line.startsWith('SVEND ')){"],
  ['session.mjs','a timed-out session is not marked tainted',"if(e instanceof TimeoutError)tainted=true;",""],
  ['session.mjs','output is not bounded',"if(rows.length>=MAX_ROWS||rowChars+line.length>MAX_CHARS){overflow=true;return;}",""],
  ['session.mjs','closing never escalates to SIGKILL',"try{child.kill('SIGKILL');proof.terminated=true;}catch{proof.uncertain=true;}",""],
  ['cases.mjs','immutability of evidence is not asserted',"await assertImmutable(h,'clearerA',hold.id,key);",""],
  ['cases.mjs','the role-change transitions are shortened',"        [{action:'remove-rule',kind:'fault'},'no_clearance_rule'],\n",""],
  ['cases.mjs','the deactivated-member transition is dropped',"        [{action:'set-membership-active',actor:'clearerA',active:false},'hold_not_found'],\n",""],

  // ---- SV-036 ----
  ['session.mjs','SV-036: a session may be opened after the deadline',"if(deadline.expired())throw new TimeoutError(`${name}:open`);",""],
  ['session.mjs','SV-036: SQL is written after the deadline (also for queued work)',"if(deadline.expired())return Promise.reject(new TimeoutError(`${name}:submit`));",""],
  ['session.mjs','SV-036: no stream has an error listener',"for(const stream of [child.stdin,child.stdout,child.stderr])stream?.on?.('error',()=>fault('stream_error','stream_error'));",""],
  ['session.mjs','SV-036: stdin has no error listener',"[child.stdin,child.stdout,child.stderr])stream?.on","[child.stdout,child.stderr])stream?.on"],
  ['session.mjs','SV-036: stdout has no error listener',"[child.stdin,child.stdout,child.stderr])stream?.on","[child.stdin,child.stderr])stream?.on"],
  ['session.mjs','SV-036: stderr has no error listener',"[child.stdin,child.stdout,child.stderr])stream?.on","[child.stdin,child.stdout])stream?.on"],
  ['session.mjs','SV-036: a stream error does not reject pending work',"broken??=pendingCode;finishCurrent(null,new SessionError(pendingCode));","broken??=pendingCode;"],
  ['session.mjs','SV-036: a broken session keeps accepting work',"if(exited||broken)return reject(new SessionError(broken??'session_closed'));","if(exited)return reject(new SessionError('session_closed'));"],
  ['session.mjs','SV-036: faults are not exposed',"faults:()=>faults.map(f=>({...f})),","faults:()=>[],"],
  ['session.mjs','SV-036: a process error counts as exit',"child.on('error',()=>fault('process_error','session_error'));","child.on('error',()=>{fault('process_error','session_error');exited=true;});"],
  ['session.mjs','SV-036: a process error is not recorded',"child.on('error',()=>fault('process_error','session_error'));","child.on('error',()=>{broken??='session_error';finishCurrent(null,new SessionError('session_error'));});"],
  ['session.mjs','SV-036: a close event is not proof of exit',"child.on('exit',onGone);child.on('close',onGone);","child.on('exit',onGone);"],
  ['session.mjs','SV-036: a recorded exit code is not proof of exit',"const gone=()=>exited||(child.exitCode!=null)||(child.signalCode!=null);","const gone=()=>exited;"],
  ['session.mjs','SV-036: cleanup does not wait for the exit',"if(gone()||await waitExit(2000)){proof.graceful=true;","if(true){proof.graceful=true;"],
  ['runner.mjs','SV-036: faults do not affect cleanup certainty',"if(faults.length>0)receipt.cleanup.certain=false;",""],
  ['runner.mjs','SV-036: faults are not in the receipt',"receipt.cleanup.faults=faults.map(({name,code})=>({name,code}));",""],
  ['runner.mjs','SV-036: handles the runner never got are not closed',"for(const handle of factory.ownedHandles())if(!attempted.has(handle)&&!await closeHandle(handle))receipt.cleanup.certain=false;",""],
  ['runner.mjs','SV-036: a close that throws counts as certain',"uncertain:true});return false;}\n  };","uncertain:true});return true;}\n  };"],
  ['runner.mjs','SV-036: an uncertain close proof counts as certain',"graceful:proof.graceful,terminated:proof.terminated,uncertain:proof.uncertain});return !proof.uncertain;}","graceful:proof.graceful,terminated:proof.terminated,uncertain:proof.uncertain});return true;}"],
  ['cases.mjs','SV-036: the schema version is not compared',"must(schema==='1','persisted_schema_version');",""],
  ['cases.mjs','SV-036: the reference is not compared',"must(reference===p.reference,'persisted_reference');",""],
  ['cases.mjs','SV-036: the observed time is not compared',"must(Number.isFinite(Date.parse(observedAt))&&Date.parse(observedAt)===Date.parse(p.observedAt),'persisted_observed_at');",""],
  ['cases.mjs','SV-036: the note is not compared',"must(p.note===null?noteIsNull==='t':noteIsNull==='f'&&note===p.note,'persisted_note');",""],
  ['cases.mjs','SV-036: the hold identity is not compared',"must(evHold===hold.id,'persisted_hold');",""],
  ['cases.mjs','SV-036: the tenant is not compared',"must(evOrg===org,'persisted_tenant');",""],
  ['cases.mjs','SV-036: the recording actor is not compared',"must(recordedBy===who,'persisted_actor');",""],
  ['cases.mjs','SV-036: the replay identity is not compared',"if(evidenceId!==undefined)must(id===evidenceId,'persisted_evidence_identity');",""],
  ['cases.mjs','SV-036: the receipt count is not checked',"must(rc.length===1,'persisted_receipt_count');",""],
  ['cases.mjs','SV-036: the receipt link is not compared',"must(rHold===hold.id&&rEvidence===id&&rActor===who&&rOrg===org,'persisted_receipt_link');",""],
  ['cases.mjs','SV-036: the receipt hash is not compared',"must(rHash===p.hash,'persisted_receipt_hash');",""],
  ['cases.mjs','SV-036: sameKeyReplay skips the persisted check',"await assertPersisted(h,'clearerA',{hold,p,key,evidenceId:a.value.evidenceId});\n      await assertImmutable","await assertImmutable"],
  ['cases.mjs','SV-036: differentKeyCompetingClear skips the persisted check',"      await assertPersisted(h,'clearerA',{hold,p:p1,key:k1,evidenceId:a.value.evidenceId});",""],
  ['cases.mjs','SV-036: the stacked-hold clear skips the persisted check',"      await assertPersisted(h,'clearerA',{hold:first,p,key,evidenceId:a.value.evidenceId});",""],
  ['cases.mjs','SV-036: the last-hold clear skips the persisted check',"      await assertPersisted(h,'clearerA',{hold:single.hold,p:sp,key:sKey,evidenceId:s.value.evidenceId});",""],
  ['cases.mjs','SV-036: rollbackInterleavings skips the persisted check',"      await assertPersisted(h,'clearerA',{hold:h1,p:p1,key:k1,evidenceId:b.value.evidenceId});",""],
  ['cases.mjs','SV-036: roleOrRuleChangeBeforeReplay skips the persisted check',"      await assertPersisted(h,'clearerA',{hold,p,key,evidenceId:first.value.evidenceId});",""],
  ['cases.mjs','SV-036: actorPrivateConflict skips the persisted check',"      await assertPersisted(h,'clearerA',{hold:h1,p:p1,key,evidenceId:first.value.evidenceId});",""],
  ['cases.mjs','SV-036: tenantDenial no longer confirms populated evidence',"      must((await evidenceRows(h,'clearerA',hold.id)).length===1,'tenant_evidence_not_populated');",""],
  ['cases.mjs','SV-036: tenantDenial does not re-check the record after the denied attempts',"      await assertPersisted(h,'clearerA',{hold,p,key:setupKey,evidenceId:setup.value.evidenceId});      // unchanged by the denied attempts",""],
  ['cases.mjs','SV-036: the other tenant\'s evidence read is not checked',"      must((await h.read('outsider',q.evidenceDetail(hold.id))).rows.length===0,'other_tenant_can_read_evidence');",""],
  ['cases.mjs','SV-036: the other tenant\'s receipt read is not checked',"      must((await h.read('outsider',q.receiptDetail(setupKey))).rows.length===0,'other_tenant_can_read_receipt');",""],
  ['cases.mjs','SV-036: the other tenant\'s hold read is not checked',"      must((await h.read('outsider',q.holdState(hold.id))).rows.length===0,'other_tenant_can_read_hold');",""],
  ['cases.mjs','SV-036: tenantDenial skips the populating clear',"      const setup=await openClear(h,A,'clearerA',p,setupKey);\n      must(setup.ok&&setup.value?.replayed===false&&setup.value.cleared===true,'tenant_setup_clear_failed');\n      await finishTxn(h,A,COMMIT);","      const setup={ok:true,value:{replayed:false,cleared:true,evidenceId:'x'}};"],
  ['preflight.mjs','SV-036: function owners are not required to be readable',"check('function_owners_readable',ownersReadable,'function_owner_unreadable');","check('function_owners_readable',true,'x');"],
  ['preflight.mjs','SV-036: a function owned by the runtime role is tolerated',"check('function_owner_is_not_runtime_role',rows.every(c=>c[3]!==r.runtimeRole),'runtime_role_owns_protected_functions');","check('function_owner_is_not_runtime_role',true,'x');"],
  ['preflight.mjs','SV-036: only the first function\'s owner is checked',"check('function_owner_is_not_runtime_role',rows.every(c=>c[3]!==r.runtimeRole)","check('function_owner_is_not_runtime_role',rows.slice(0,1).every(c=>c[3]!==r.runtimeRole)"],
  ['preflight.mjs','SV-036: membership in function owner roles is not checked',"      rows.forEach(c=>ownerNames.add(c[3]));\n",""],
  ['preflight.mjs','SV-036: a membership answer of the wrong size is accepted',"if(!answer||answer.length!==list.length)check('not_member_of_owner_roles',false,'owner_membership_unreadable');\n      else ","if(!answer)check('not_member_of_owner_roles',false,'owner_membership_unreadable');\n      else "],
];
const files=[...new Set(M.map(m=>m[0]))],orig=Object.fromEntries(files.map(f=>[f,readFileSync(join(dir,f),'utf8')]));
const run=()=>spawnSync(process.execPath,['--test',suite],{encoding:'utf8',env:{PATH:process.env.PATH}});
const num=(out,key)=>Number((new RegExp(`^ℹ ${key} (\\d+)`,'m').exec(out)||[])[1]??NaN);
const base=run();console.log(`baseline: ${num(base.stdout,'pass')} pass, ${num(base.stdout,'fail')} fail, ${num(base.stdout,'skipped')} skipped (the 1 skipped is the inert native test)`);
if(num(base.stdout,'fail')!==0){console.error('The tests must pass before mutating. Stopping.');process.exit(2);}
let gaps=0,caughtCount=0,overlapCount=0;
try{
  for(const [file,name,from,to,overlap] of M){
    const froms=[].concat(from),tos=[].concat(to);
    if(!froms.every(x=>orig[file].includes(x))){console.log(`NOT APPLICABLE  ${name}  (source changed: update this inventory)`);gaps++;continue;}
    let mutated=orig[file];froms.forEach((x,i)=>{mutated=mutated.replace(x,tos[i]);});
    writeFileSync(join(dir,file),mutated);const out=run();writeFileSync(join(dir,file),orig[file]);
    const failed=num(out.stdout,'fail'),caught=failed>0||out.status!==0;
    if(caught)caughtCount++;else if(overlap==='OVERLAP')overlapCount++;else gaps++;
    console.log(`${caught?'caught  ':overlap==='OVERLAP'?'survived (expected overlapping layer)':'SURVIVED'}  ${name}  (${Number.isNaN(failed)?'would not run':failed+' failing'})`);
  }
}finally{for(const f of files)writeFileSync(join(dir,f),orig[f]);}
for(const f of files)if(readFileSync(join(dir,f),'utf8')!==orig[f]){console.error(`NOT RESTORED: ${f}`);process.exit(3);}
console.log(gaps?`${gaps} mutation(s) not caught: the tests have a gap.`:`${M.length} entries: ${caughtCount} caught, ${overlapCount} survive by design (overlapping layer, combined entry caught); files restored.`);
process.exit(gaps?1:0);
