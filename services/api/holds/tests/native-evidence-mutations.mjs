// Mutation inventory for the SV-034 harness. NOT a test and not part of any suite: run it by hand.
//   node services/api/holds/tests/native-evidence-mutations.mjs
// It breaks the harness on purpose, one change at a time, runs evidence-native.test.mjs (pure tests with fakes; it never connects), and
// reports whether the tests noticed. A mutation that no test catches is a gap (exit 1). Files are restored and verified byte for byte.
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
  ['runner.mjs','cases run although the preflight failed',"if(!receipt.preflight.passed){receipt.cases=notRun('preflight_failed');return finish();}","if(false){receipt.cases=notRun('preflight_failed');return finish();}"],
  ['runner.mjs','a timeout is treated as a pass',"entry.status=STATUS.UNCERTAIN;entry.code='deadline_exceeded';","entry.status=STATUS.PASS;entry.code='deadline_exceeded';"],
  ['runner.mjs','an unexpected error is treated as a pass',"else{entry.status=STATUS.UNCERTAIN;entry.code='harness_error';}","else{entry.status=STATUS.PASS;entry.code='harness_error';}"],
  ['runner.mjs','a dying session is treated as a pass',"else if(e instanceof SessionError){entry.status=STATUS.UNCERTAIN;","else if(e instanceof SessionError){entry.status=STATUS.PASS;"],
  ['runner.mjs','a failed cleanup does not downgrade a pass',"if(entry.status===STATUS.PASS){entry.status=STATUS.UNCERTAIN;entry.code='cleanup_uncertain';}","if(false){entry.status=STATUS.UNCERTAIN;entry.code='cleanup_uncertain';}"],
  ['runner.mjs','open transactions are not rolled back at cleanup',"try{if(s.isOpen()&&!s.isTainted())await s.submit('ROLLBACK;',deadline);}catch{certain=false;}",""],
  ['runner.mjs','owned sessions are not closed at cleanup',"try{const proof=await s.close();receipt.cleanup.sessions.push({name:s.name,graceful:proof.graceful,terminated:proof.terminated,uncertain:proof.uncertain});if(proof.uncertain)certain=false;}\n          catch{certain=false;receipt.cleanup.sessions.push({name:s.name,graceful:false,terminated:false,uncertain:true});}",""],
  ['runner.mjs','the fixture is not restored after a control case',"if(controlUsed){try{const r=await withDeadline(control.apply({action:'restore',scope:'all'}),deadline,'control');if(!r||r.ok!==true)certain=false;}catch{certain=false;}}",""],
  ['runner.mjs','the verifier session is left open',"try{const proof=await verifier.close();","try{const proof={graceful:true,terminated:false,uncertain:false};"],
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
  ['preflight.mjs','membership in an owner role is tolerated',"check('not_member_of_owner_roles',members?.length===1&&cells(members[0]).every(f),'runtime_role_is_member_of_an_owner_role');","check('not_member_of_owner_roles',true,'x');"],
  ['preflight.mjs','the database name is not verified',"check('database',db===r.database,'wrong_database');","check('database',true,'x');"],
  ['preflight.mjs','the configured rules are not verified',"check('rules',Object.keys(fix.rules).every(k=>got[k]===fix.rules[k])&&Object.keys(got).length===Object.keys(fix.rules).length,'configured_rules_mismatch');","check('rules',true,'x');"],
  ['session.mjs','result data can spoof the end of a statement',"if(line.startsWith(`SVEND ${nonce} `)){","if(line.startsWith('SVEND ')){"],
  ['session.mjs','a timed-out session is not marked tainted',"if(e instanceof TimeoutError)tainted=true;",""],
  ['session.mjs','output is not bounded',"if(rows.length>=MAX_ROWS||rowChars+line.length>MAX_CHARS){overflow=true;return;}",""],
  ['session.mjs','closing never escalates to SIGKILL',"try{child.kill('SIGKILL');proof.terminated=true;}catch{proof.uncertain=true;}",""],
  ['cases.mjs','immutability of evidence is not asserted',"await assertImmutable(h,'clearerA',hold.id,key);",""],
  ['cases.mjs','the role-change transitions are shortened',"        [{action:'remove-rule',kind:'fault'},'no_clearance_rule'],\n",""],
  ['cases.mjs','the deactivated-member transition is dropped',"        [{action:'set-membership-active',actor:'clearerA',active:false},'hold_not_found'],\n",""],
];
const files=[...new Set(M.map(m=>m[0]))],orig=Object.fromEntries(files.map(f=>[f,readFileSync(join(dir,f),'utf8')]));
const run=()=>spawnSync(process.execPath,['--test',suite],{encoding:'utf8',env:{PATH:process.env.PATH}});
const num=(out,key)=>Number((new RegExp(`^ℹ ${key} (\\d+)`,'m').exec(out)||[])[1]??NaN);
const base=run();console.log(`baseline: ${num(base.stdout,'pass')} pass, ${num(base.stdout,'fail')} fail, ${num(base.stdout,'skipped')} skipped (the 1 skipped is the inert native test)`);
if(num(base.stdout,'fail')!==0){console.error('The tests must pass before mutating. Stopping.');process.exit(2);}
let gaps=0;
try{
  for(const [file,name,from,to] of M){
    if(!orig[file].includes(from)){console.log(`NOT APPLICABLE  ${name}  (source changed: update this inventory)`);gaps++;continue;}
    writeFileSync(join(dir,file),orig[file].replace(from,to));const out=run();writeFileSync(join(dir,file),orig[file]);
    const failed=num(out.stdout,'fail'),caught=failed>0||out.status!==0;if(!caught)gaps++;
    console.log(`${caught?'caught  ':'SURVIVED'}  ${name}  (${Number.isNaN(failed)?'would not run':failed+' failing'})`);
  }
}finally{for(const f of files)writeFileSync(join(dir,f),orig[f]);}
for(const f of files)if(readFileSync(join(dir,f),'utf8')!==orig[f]){console.error(`NOT RESTORED: ${f}`);process.exit(3);}
console.log(gaps?`${gaps} mutation(s) not caught: the tests have a gap.`:`All ${M.length} mutations caught; files restored.`);
process.exit(gaps?1:0);
