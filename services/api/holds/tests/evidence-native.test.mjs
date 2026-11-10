// SV-034: opt-in NATIVE hold-evidence concurrency acceptance harness, plus the pure tests that prove the harness itself.
//   node --test services/api/holds/tests/evidence-native.test.mjs
//
// WHAT RUNS HERE: only pure tests that use injected fakes (a fake child process, a fake database model, a fake clock). They never open a
// connection, never spawn a process, and never read the environment's database settings, even on a machine with PostgreSQL installed.
// WHAT DOES NOT RUN HERE: the native cases. They need an explicit, scoped opt-in and a synthetic isolated target supplied by a supervised
// runner (see NATIVE-EVIDENCE.md). Without it they are reported as SKIPPED. A skipped, incomplete or uncertain native run is never a pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join} from 'node:path';
import {parseContract,buildPsqlInvocation,redact,BoundedText,ContractError,OPT_IN_SCOPE,REQUIRED_ACTORS} from './native-evidence/contract.mjs';
import {lit,uuidLit,ident,beginAs,prepareClear,clearCall,claimCall,svCode,parseJsonCell,SqlBuildError,q} from './native-evidence/sql.mjs';
import {createPsqlSessionFactory,Deadline,withDeadline,TimeoutError,SessionError,MAX_ROWS} from './native-evidence/session.mjs';
import {runPreflight,FORCED_RELATIONS,FUNCTIONS,nameOf} from './native-evidence/preflight.mjs';
import {runAcceptance,redactedReceipt,STATUS} from './native-evidence/runner.mjs';
import {CASES,REQUIRED_CASE_NAMES,validateControlAction,CaseFail} from './native-evidence/cases.mjs';
import {createFakeWorld} from './native-evidence/fake-world.mjs';
import {clearanceRequestHash} from '../service.mjs';

const here=dirname(fileURLToPath(import.meta.url)),dir=join(here,'native-evidence');
const U=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const RUN='svrun-ab12cd34ef';
function rawContract(){
  const plain=Array.from({length:8},(_,i)=>({id:U(100+i),kind:'fault',equipmentId:`EQ-P${i+1}`}));
  return {
    optIn:{approved:true,scope:OPT_IN_SCOPE,runMarker:RUN},
    runtime:{psqlPath:'/opt/synthetic/pg16/bin/psql',host:'127.0.0.1',port:54329,database:'sv_svrun_ab12cd34ef',runtimeRole:'sv_runtime_ab12',passfile:'/var/run/synthetic/pgpass-ab12',expected:{serverVersionPrefix:'16.',databaseOwner:'sv_owner_ab12'},deadlineMs:5000},
    fixture:{
      organizations:{a:U(1),b:U(2)},
      actors:{clearerA:{userId:U(11),organization:'a',role:'equipment_manager'},clearerA2:{userId:U(12),organization:'a',role:'equipment_manager'},operator:{userId:U(13),organization:'a',role:'operator'},outsider:{userId:U(14),organization:'b',role:'admin'}},
      rules:{dirty:'supply_manager',fault:'equipment_manager',maintenance:'equipment_manager',unknown:'admin'},
      holds:[...plain,{id:U(120),kind:'fault',equipmentId:'EQ-S1'},{id:U(121),kind:'maintenance',equipmentId:'EQ-S1'},{id:U(122),kind:'fault',equipmentId:'EQ-S2'}],
      requests:[{requestId:U(200),line:1,equipmentId:'EQ-S1'},{requestId:U(201),line:1,equipmentId:'EQ-S2'}],
      control:'external-runner-v1',
    },
  };
}
const contractOf=(mutate=()=>{})=>{const r=rawContract();mutate(r);return parseContract(r);};
const realClock={now:()=>Date.now(),setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:h=>clearTimeout(h)};
const fastClock={now:()=>Date.now(),setTimer:(fn)=>setTimeout(fn,1),clearTimer:h=>clearTimeout(h)};   // timers fire at once: bounded waits finish instantly

// ---------------- the contract: nothing is discovered, defaulted or inherited ----------------
test('a valid contract parses; the opt-in must be explicit and scoped to this suite',()=>{
  const c=contractOf();
  assert.equal(c.runMarker,RUN);assert.equal(c.runtime.database,'sv_svrun_ab12cd34ef');assert.equal(Object.isFrozen(c),true);
  for(const mutate of [r=>{r.optIn.approved=false;},r=>{r.optIn.approved='yes';},r=>{r.optIn.scope='something-else';},r=>{delete r.optIn;},r=>{r.optIn.runMarker='prod';},r=>{r.optIn.runMarker='svrun-ABC12345';}])
    assert.throws(()=>contractOf(mutate),ContractError);
});
test('the target must be an isolated, loopback, run-bound synthetic database; no secrets, no relative paths, no unknown fields',()=>{
  const bad={
    'non-loopback host':r=>{r.runtime.host='db.example.test';},'wildcard host':r=>{r.runtime.host='0.0.0.0';},'privileged port':r=>{r.runtime.port=80;},
    'database not bound to the run':r=>{r.runtime.database='sv_production';},'database of another run':r=>{r.runtime.database='sv_svrun_00000000aa';},
    'relative psql':r=>{r.runtime.psqlPath='psql';},'psql path traversal':r=>{r.runtime.psqlPath='/opt/../usr/bin/psql';},'not psql':r=>{r.runtime.psqlPath='/usr/bin/sh';},
    'relative passfile':r=>{r.runtime.passfile='pgpass';},'default superuser role':r=>{r.runtime.runtimeRole='postgres';},
    'owner equals runtime role':r=>{r.runtime.expected.databaseOwner=r.runtime.runtimeRole;},'bad version prefix':r=>{r.runtime.expected.serverVersionPrefix='latest';},
    'deadline too long':r=>{r.runtime.deadlineMs=3600000;},'deadline too short':r=>{r.runtime.deadlineMs=10;},
    'password field':r=>{r.runtime.password='x';},'connection string field':r=>{r.runtime.connectionString='postgres://x';},'token field':r=>{r.fixture.token='x';},'unknown field':r=>{r.runtime.extra=1;},
    'missing actor':r=>{delete r.fixture.actors.outsider;},'duplicate user':r=>{r.fixture.actors.outsider.userId=r.fixture.actors.operator.userId;},
    'outsider in the same org':r=>{r.fixture.actors.outsider.organization='a';},'clearers with different roles':r=>{r.fixture.actors.clearerA2.role='viewer';},
    'rules not matching the clearers':r=>{r.fixture.rules.fault='viewer';},'bad role':r=>{r.fixture.actors.operator.role='janitor';},
    'same organization twice':r=>{r.fixture.organizations.b=r.fixture.organizations.a;},'duplicate hold':r=>{r.fixture.holds[1].id=r.fixture.holds[0].id;},
    'no holds':r=>{r.fixture.holds=[];},'bad control contract':r=>{r.fixture.control='in-harness';},'bad hold kind':r=>{r.fixture.holds[0].kind='broken';},
  };
  for(const [name,mutate] of Object.entries(bad))assert.throws(()=>contractOf(mutate),ContractError,name);
  for(const [name,mutate] of Object.entries({'password field':bad['password field'],'connection string field':bad['connection string field'],'token field':bad['token field']}))
    assert.throws(()=>contractOf(mutate),e=>e instanceof ContractError&&e.code==='secret_field_refused',`${name} must be refused as a secret`);
  // Errors name a path, never a value.
  try{contractOf(r=>{r.runtime.host='SECRET-HOST-VALUE';});assert.fail('should throw');}catch(e){assert.ok(!e.message.includes('SECRET-HOST-VALUE'));assert.match(e.message,/runtime\.host/);}
  try{contractOf(r=>{r.runtime.password='SECRET-PW';});assert.fail('should throw');}catch(e){assert.ok(!e.message.includes('SECRET-PW'));}
});
test('a session process is described with a clean, allowlisted environment and no password prompt',()=>{
  const c=contractOf();
  const before={PGPASSWORD:process.env.PGPASSWORD,PGSERVICE:process.env.PGSERVICE,PGHOST:process.env.PGHOST,DATABASE_URL:process.env.DATABASE_URL};
  Object.assign(process.env,{PGPASSWORD:'LEAK-PW',PGSERVICE:'LEAK-SVC',PGHOST:'leak.example.test',DATABASE_URL:'postgres://leak'});
  try{
    const inv=buildPsqlInvocation(c,'a');
    assert.equal(inv.command,c.runtime.psqlPath);assert.equal(inv.options.shell,false);
    assert.deepEqual(Object.keys(inv.env).sort(),['LC_ALL','PGAPPNAME','PGCONNECT_TIMEOUT','PGOPTIONS','PGPASSFILE','PGSSLMODE']);
    assert.equal(inv.env.PGPASSFILE,c.runtime.passfile);assert.equal(inv.appName,`${RUN}-a`);
    assert.ok(inv.args.includes('-w'),'never prompts for a password');assert.deepEqual(inv.args.slice(inv.args.indexOf('-h'),inv.args.indexOf('-h')+4),['-h','127.0.0.1','-p','54329']);
    assert.ok(!JSON.stringify(inv).includes('LEAK'),'nothing from the process environment is inherited');
    assert.ok(!inv.args.some(a=>/password|postgres:\/\//i.test(a)));
    for(const name of ['','A','1a','a b','a;b','x'.repeat(17)])assert.throws(()=>buildPsqlInvocation(c,name),ContractError);
  }finally{for(const [k,v] of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
test('output is bounded and redacted: supplied paths, host, database, role and run marker never reach a receipt',()=>{
  const c=contractOf();
  const b=new BoundedText(10);b.push('0123456789');b.push('more');assert.equal(b.toString(),'0123456789');assert.equal(b.truncated,true);
  const dirty=`failed at ${c.runtime.passfile} using ${c.runtime.psqlPath} on ${c.runtime.host}:${c.runtime.port} db ${c.runtime.database} role ${c.runtime.runtimeRole} run ${RUN} in /home/someone/work/file.txt`;
  const clean=redact(dirty,c);
  for(const needle of [c.runtime.passfile,c.runtime.psqlPath,c.runtime.database,c.runtime.runtimeRole,RUN,'/home/someone'])assert.ok(!clean.includes(needle),needle);
  assert.ok(redact('x'.repeat(1000),c).length<=301);
});

// ---------------- statements: only validated values reach SQL ----------------
test('SQL builders refuse anything that is not a plain value, and the hash is the one the API computes',()=>{
  for(const bad of ["a'b",'a"b','a\\b','a\nb','a;b','a--b'.replace('--','`'),5,null,undefined])assert.throws(()=>lit(bad),SqlBuildError);
  assert.equal(lit('Cleaning log #12'),"'Cleaning log #12'");assert.throws(()=>uuidLit('not-a-uuid'),SqlBuildError);assert.throws(()=>ident('a b'),SqlBuildError);
  const c=contractOf();assert.match(beginAs(c,'clearerA'),/^BEGIN;\nSET LOCAL sv\.user_id = '[^']+';\nSET LOCAL sv\.organization_id = '[^']+';$/);assert.throws(()=>beginAs(c,'nobody'),SqlBuildError);
  const p=prepareClear({holdId:U(100),reference:'LOG-1',observedAt:new Date(Date.now()-60000).toISOString(),note:'native note'});
  assert.equal(p.hash,clearanceRequestHash(U(100),{schemaVersion:1,evidence:{reference:'LOG-1',observedAt:p.observedAt,note:'native note'}}));
  assert.match(clearCall(p,'key-1'),/^SELECT public\.clear_equipment_hold_with_evidence\('[^']+'::uuid, 'key-1', '[0-9a-f]{64}', 'LOG-1', '[^']+'::timestamptz, 'native note'\);$/);
  assert.match(claimCall(U(200),1,U(300),0,`user:${U(13)}`),/claim_request_item/);assert.throws(()=>claimCall(U(200),'1',U(300),0,'u'),SqlBuildError);
  assert.equal(svCode('ERROR: sv:wrong_role (x)'),'wrong_role');assert.equal(svCode('plain'),null);assert.deepEqual(parseJsonCell('{"a": 1}'),{a:1});assert.equal(parseJsonCell('nope'),null);
  assert.throws(()=>q.lockWaiters("x'y"),SqlBuildError);
});
test('only bounded, fictional control actions can be requested from the supervised runner',()=>{
  for(const ok of [{action:'set-rule',kind:'fault',role:'viewer'},{action:'remove-rule',kind:'fault'},{action:'set-membership-role',actor:'clearerA',role:'viewer'},{action:'set-membership-active',actor:'clearerA',active:false},{action:'restore',scope:'all'}])
    assert.deepEqual(validateControlAction(ok),ok);
  for(const bad of [null,{},{action:'drop-database'},{action:'set-rule',kind:'fault',role:'root'},{action:'set-rule',kind:'fault',role:'viewer',extra:1},{action:'set-membership-role',actor:'postgres',role:'viewer'},{action:'set-membership-active',actor:'clearerA',active:'no'},{action:'restore',scope:'everything'},{action:'remove-rule',kind:'x'}])
    assert.throws(()=>validateControlAction(bad),CaseFail,JSON.stringify(bad));
});

// ---------------- the session wrapper, driven by a fake child process ----------------
function fakeChild(reply){
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.signals=[];child.input=[];let gone=false;
  const exit=()=>{if(!gone){gone=true;child.emit('exit',0,null);}};
  child.die=exit;
  child.stdin={write(text){
    if(gone)throw new Error('EPIPE');child.input.push(text);
    if(text.startsWith('\\q')){if(!reply.ignoreQuit)queueMicrotask(exit);return;}
    const m=/\\echo SVEND (\S+) (\d+) /.exec(text);if(!m)return;
    const sql=text.slice(0,text.indexOf('\n\\echo'));const r=reply.on?.(sql,m)??{rows:[]};
    if(r.silent)return;
    const out=[...(r.rawLines??[]),...(r.rows??[]),`SVEND ${r.nonce??m[1]} ${r.seq??m[2]} ${r.error?'true':'false'} ${r.error?.sqlstate??'00000'} ${r.error?.message??''}`].join('\n')+'\n';
    if(r.chunks){for(let i=0;i<out.length;i+=r.chunks)queueMicrotask(()=>child.stdout.emit('data',out.slice(i,i+r.chunks)));}else queueMicrotask(()=>child.stdout.emit('data',out));
  },end(){}};
  child.kill=sig=>{child.signals.push(sig);if(reply.dieOn===sig)queueMicrotask(exit);return true;};
  return child;
}
const factoryWith=(reply,clock=fastClock,c=contractOf())=>{
  const spawned=[];
  const spawn=(command,args,options)=>{const ch=fakeChild(reply);spawned.push({command,args,options,child:ch});return ch;};
  return {contract:c,spawned,factory:createPsqlSessionFactory({contract:c,spawn,clock,newNonce:()=>'nonce1'})};
};
const base={on:(sql)=>sql.startsWith('SELECT pg_backend_pid')?{rows:['4242']}:{rows:[]}};
test('a session is opened with the clean invocation, reports its backend PID, and returns rows and errors in order',async()=>{
  const {factory,spawned,contract}=factoryWith({on:(sql)=>{
    if(sql.startsWith('SELECT pg_backend_pid'))return {rows:['4242']};
    if(sql==='SELECT 1')return {rows:['1']};
    if(sql==='BOOM')return {error:{sqlstate:'SV409',message:`sv:hold_already_cleared at ${'/secret/dir/file'} for ${RUN}`}};
    return {rows:[]};
  }});
  const dl=Deadline.after(fastClock,5000);
  const s=await factory.open('a',dl);
  assert.equal(s.pid,4242);assert.equal(s.appName,`${RUN}-a`);assert.equal(spawned[0].command,contract.runtime.psqlPath);assert.equal(spawned[0].options.shell,false);
  assert.deepEqual((await s.submit('SELECT 1',dl)).rows,['1']);
  const bad=await s.submit('BOOM',dl);assert.equal(bad.error.sqlstate,'SV409');assert.equal(svCode(bad.error.message),'hold_already_cleared');
  assert.ok(!bad.error.message.includes('/secret/dir')&&!bad.error.message.includes(RUN),'error text is redacted');
  assert.deepEqual(factory.ownedHandles().map(h=>h.name),['a']);
  const proof=await s.close();assert.equal(proof.graceful,true);assert.equal(factory.ownedHandles().length,0);
});
test('statements on one session run in order; framing survives chunked output and cannot be spoofed by result data',async()=>{
  const order=[];
  const {factory}=factoryWith({on:(sql)=>{order.push(sql);
    if(sql.startsWith('SELECT pg_backend_pid'))return {rows:['1']};
    if(sql==='SPOOF')return {rawLines:['SVEND wrongnonce 2 true XX000 fake','SVEND nonce1 99 true XX000 fake'],rows:['real']};
    return {rows:[sql],chunks:7};
  }});
  const dl=Deadline.after(fastClock,5000),s=await factory.open('a',dl);
  const [r1,r2,r3]=await Promise.all([s.submit('ONE',dl),s.submit('TWO',dl),s.submit('SPOOF',dl)]);
  assert.deepEqual(order.slice(1),['ONE','TWO','SPOOF']);assert.deepEqual([r1.rows,r2.rows],[['ONE'],['TWO']]);
  assert.equal(r3.error,null);assert.deepEqual(r3.rows.slice(-1),['real']);
  assert.ok(r3.rows.includes('SVEND wrongnonce 2 true XX000 fake'),'a line with the wrong nonce is plain data, not a sentinel');
  assert.equal(r3.rows.length,2,'a line with the right nonce but a sequence number we are not waiting for is ignored, and does not end the statement early');
  await s.close();
});
test('output is finite: too many rows set the overflow flag instead of growing',async()=>{
  const {factory}=factoryWith({on:(sql)=>sql.startsWith('SELECT pg_backend_pid')?{rows:['1']}:{rows:Array.from({length:MAX_ROWS+50},(_,i)=>`row${i}`)}});
  const dl=Deadline.after(fastClock,5000),s=await factory.open('a',dl),r=await s.submit('BIG',dl);
  assert.equal(r.overflow,true);assert.equal(r.rows.length,MAX_ROWS);await s.close();
});
test('a statement that never completes hits the shared deadline, taints the session, and cleanup is still bounded',async()=>{
  let silent=false;
  const {factory}=factoryWith({ignoreQuit:true,dieOn:'SIGTERM',on:(sql)=>sql.startsWith('SELECT pg_backend_pid')?{rows:['1']}:silent?{silent:true}:{rows:[]}});
  const dl=Deadline.after(realClock,60),s=await factory.open('a',dl);silent=true;
  await assert.rejects(s.submit('HANG',dl),TimeoutError);assert.equal(s.isTainted(),true);
  const proof=await s.close();assert.deepEqual([proof.terminated,proof.uncertain],[true,false],'only the owned handle was signalled');
  assert.equal(factory.ownedHandles().length,0);
});
test('closing escalates only on the owned child (quit, then SIGTERM, then SIGKILL) and admits uncertainty when it cannot confirm',async()=>{
  for(const [reply,expect] of [[{},{graceful:true,terminated:false,uncertain:false}],[{ignoreQuit:true,dieOn:'SIGTERM',on:base.on},{graceful:false,terminated:true,uncertain:false}],[{ignoreQuit:true,dieOn:'SIGKILL',on:base.on},{graceful:false,terminated:true,uncertain:false}],[{ignoreQuit:true,on:base.on},{graceful:false,terminated:true,uncertain:true}]]){
    const {factory,spawned}=factoryWith({...base,...reply});const dl=Deadline.after(fastClock,5000),s=await factory.open('a',dl);
    const proof=await s.close();
    assert.deepEqual({graceful:proof.graceful,terminated:proof.terminated,uncertain:proof.uncertain},expect,JSON.stringify(reply));
    assert.ok(spawned[0].child.signals.every(sig=>['SIGTERM','SIGKILL'].includes(sig)));
    assert.equal(factory.ownedHandles().length,proof.uncertain?1:0,'an unconfirmed session stays reported as owned');
  }
});
test('a dead session, a failed spawn and a missing PID are SessionErrors, never silent',async()=>{
  const {factory,spawned}=factoryWith({on:(sql)=>sql.startsWith('SELECT pg_backend_pid')?{rows:['7']}:{silent:true}});
  const dl=Deadline.after(realClock,2000),s=await factory.open('a',dl);
  const pending=s.submit('WAIT',dl);spawned[0].child.die();
  await assert.rejects(pending,e=>e instanceof SessionError&&e.code==='session_closed');
  await assert.rejects(s.submit('LATER',dl),SessionError);
  const throwing=createPsqlSessionFactory({contract:contractOf(),spawn:()=>{throw new Error('ENOENT');},clock:fastClock,newNonce:()=>'n'});
  await assert.rejects(throwing.open('a',dl),e=>e.code==='spawn_failed');
  const nopid=factoryWith({on:()=>({rows:['not-a-number']})});
  await assert.rejects(nopid.factory.open('a',dl),SessionError);assert.equal(nopid.factory.ownedHandles().length,0,'a session that never became ready is not left open');
  assert.throws(()=>createPsqlSessionFactory({contract:contractOf(),clock:fastClock}),SessionError,'spawn must be injected');
});
test('withDeadline settles with the value, the rejection, or a TimeoutError, and clears its timer',async()=>{
  const dl=Deadline.after(realClock,100);
  assert.equal(await withDeadline(Promise.resolve(5),dl,'x'),5);
  await assert.rejects(withDeadline(Promise.reject(new Error('boom')),dl,'x'),/boom/);
  await assert.rejects(withDeadline(new Promise(()=>{}),Deadline.after(realClock,20),'x'),TimeoutError);
  await assert.rejects(withDeadline(Promise.resolve(1),Deadline.after(realClock,-5),'x'),TimeoutError,'an expired deadline refuses immediately');
});

// ---------------- the preflight fails closed ----------------
function healthyAnswers(c,over={}){
  const r=c.runtime,f=c.fixture,rls=name=>name==='auth_user'?'t|f':'t|t';
  return sql=>{
    const hit=(k)=>over[k]??null;
    if(sql.includes('current_database(), current_user'))return hit('identity')??[`${r.database}|${r.runtimeRole}|${r.runtimeRole}|16.4|127.0.0.1|${r.port}`];
    if(sql.includes('rolsuper'))return hit('attrs')??['f|f|f|f|f'];
    if(sql.includes('pg_get_userbyid(datdba)'))return hit('owners')??[`${r.expected.databaseOwner}|database`,`${r.expected.databaseOwner}|schema`,`${r.expected.databaseOwner}|relation`];
    if(sql.includes("'MEMBER'"))return hit('member')??['f'];
    if(sql.includes('relrowsecurity'))return hit('rls')??[...FORCED_RELATIONS,'auth_user'].map(n=>`${n}|${rls(n)}`);
    if(sql.includes('to_regprocedure')&&sql.includes('prosecdef'))return hit('fns')??FUNCTIONS.map((fn,i)=>`${nameOf(fn)}|f|${i===0?'t':'f'}`);
    if(sql.includes('has_table_privilege'))return hit('priv')??['hold_clearance_evidence|t|t|f|f|f|f|f','hold_clearance_receipt|t|t|f|f|f|f|f','execute|t'];
    if(sql.includes('FROM organization WHERE id'))return hit('org')??[`Synthetic org ${RUN}|id`];
    if(sql.includes('FROM auth_membership'))return hit('member_row')??['1'];
    if(sql.includes('FROM hold_clearance_rule'))return hit('rules')??Object.entries(f.rules).map(([k,v])=>`${k}|${v}`);
    if(sql.includes('FROM equipment_hold h JOIN equipment e')&&sql.includes('h.id IN'))return hit('holds')??f.holds.map(h=>`${h.id}|${h.kind}|${h.equipmentId}|t`);
    if(sql.includes('FROM request r JOIN request_item'))return hit('requests')??f.requests.map(x=>`${x.requestId}|${x.line}|open`);
    return [];
  };
}
const asQuery=answer=>async sql=>({rows:answer(sql),error:null,overflow:false});
test('a healthy synthetic target passes every preflight check',async()=>{
  const c=contractOf(),res=await runPreflight({contract:c,query:asQuery(healthyAnswers(c))});
  assert.equal(res.passed,true,JSON.stringify(res.checks.filter(x=>!x.ok)));assert.ok(res.checks.length>=18);
});
test('every unsafe or mismatched target fails the preflight with a fixed code',async()=>{
  const c=contractOf(),r=c.runtime,f=c.fixture;
  const cases={
    'wrong database':[{identity:[`other|${r.runtimeRole}|${r.runtimeRole}|16.4|127.0.0.1|${r.port}`]},'wrong_database'],
    'wrong role':[{identity:[`${r.database}|someone|someone|16.4|127.0.0.1|${r.port}`]},'wrong_role'],
    'wrong server version':[{identity:[`${r.database}|${r.runtimeRole}|${r.runtimeRole}|13.2|127.0.0.1|${r.port}`]},'wrong_server_version'],
    'not the supplied loopback server':[{identity:[`${r.database}|${r.runtimeRole}|${r.runtimeRole}|16.4|10.0.0.5|${r.port}`]},'not_the_supplied_loopback_server'],
    'wrong port':[{identity:[`${r.database}|${r.runtimeRole}|${r.runtimeRole}|16.4|127.0.0.1|5432`]},'not_the_supplied_loopback_server'],
    'superuser':[{attrs:['t|f|f|f|f']},'role_has_elevated_attribute'],
    'bypass rls':[{attrs:['f|t|f|f|f']},'role_has_elevated_attribute'],
    'security administration':[{attrs:['f|f|t|f|f']},'role_has_elevated_attribute'],
    'runtime role owns objects':[{owners:[`${r.runtimeRole}|relation`,`${r.expected.databaseOwner}|database`]},'runtime_role_owns_protected_objects'],
    'unexpected database owner':[{owners:['someone_else|database','someone_else|relation']},'unexpected_database_owner'],
    'member of an owner role':[{member:['t']},'runtime_role_is_member_of_an_owner_role'],
    'rls not forced':[{rls:[...FORCED_RELATIONS.map(n=>n==='hold_clearance_evidence'?`${n}|t|f`:`${n}|t|t`),'auth_user|t|f']},'rls_not_enabled_and_forced'],
    'rls missing on a table':[{rls:[...FORCED_RELATIONS.filter(n=>n!=='equipment_hold').map(n=>`${n}|t|t`),'auth_user|t|f']},'protected_relation_missing'],
    'auth_user exception changed':[{rls:[...FORCED_RELATIONS.map(n=>`${n}|t|t`),'auth_user|t|t']},'auth_user_exception_not_as_designed'],
    'evidence function is not 0003':[{fns:FUNCTIONS.map(fn=>`${nameOf(fn)}|f|f`)},'evidence_function_not_the_corrected_version'],
    'function is security definer':[{fns:FUNCTIONS.map((fn,i)=>`${nameOf(fn)}|t|${i===0?'t':'f'}`)},'function_is_security_definer'],
    'extra evidence privilege (UPDATE)':[{priv:['hold_clearance_evidence|t|t|t|f|f|f|f','hold_clearance_receipt|t|t|f|f|f|f|f','execute|t']},'evidence_privileges_not_select_and_insert_only'],
    'extra receipt privilege (DELETE)':[{priv:['hold_clearance_evidence|t|t|f|f|f|f|f','hold_clearance_receipt|t|t|f|t|f|f|f','execute|t']},'evidence_privileges_not_select_and_insert_only'],
    'no insert privilege':[{priv:['hold_clearance_evidence|t|f|f|f|f|f|f','hold_clearance_receipt|t|t|f|f|f|f|f','execute|t']},'evidence_privileges_not_select_and_insert_only'],
    'not executable':[{priv:['hold_clearance_evidence|t|t|f|f|f|f|f','hold_clearance_receipt|t|t|f|f|f|f|f','execute|f']},'evidence_function_not_executable'],
    'organization not bound to the run':[{org:['Production Org|id']},'organization_not_bound_to_run'],
    'actor without a matching active membership':[{member_row:['0']},'actor_membership_mismatch'],
    'configured rules differ':[{rules:Object.entries(f.rules).map(([k,v])=>k==='fault'?`${k}|viewer`:`${k}|${v}`)},'configured_rules_mismatch'],
    'extra configured rule missing':[{rules:Object.entries(f.rules).slice(1).map(([k,v])=>`${k}|${v}`)},'configured_rules_mismatch'],
    'fixture hold already cleared':[{holds:f.holds.map(h=>`${h.id}|${h.kind}|${h.equipmentId}|f`)},'fixture_holds_not_as_supplied'],
    'fixture hold on other equipment':[{holds:f.holds.map(h=>`${h.id}|${h.kind}|EQ-OTHER|t`)},'fixture_holds_not_as_supplied'],
    'fixture request not open':[{requests:f.requests.map(x=>`${x.requestId}|${x.line}|assigned`)},'fixture_requests_not_open'],
  };
  for(const [name,[over,code]] of Object.entries(cases)){
    const res=await runPreflight({contract:c,query:asQuery(healthyAnswers(c,over))});
    assert.equal(res.passed,false,name);assert.ok(res.checks.some(x=>!x.ok&&x.code===code),`${name}: expected ${code}, got ${JSON.stringify(res.checks.filter(x=>!x.ok))}`);
  }
  // A failing or overflowing query is a failed check, never a pass.
  const broken=await runPreflight({contract:c,query:async()=>({rows:[],error:{sqlstate:'XX000',message:'x'},overflow:false})});assert.equal(broken.passed,false);
  const thrown=await runPreflight({contract:c,query:async()=>{throw new Error('closed');}});assert.equal(thrown.passed,false);
  const overflow=await runPreflight({contract:c,query:async()=>({rows:[],error:null,overflow:true})});assert.equal(overflow.passed,false);
});
test('the preflight only reads: it never sends a statement that changes anything',async()=>{
  const c=contractOf(),sent=[];
  await runPreflight({contract:c,query:async sql=>{sent.push(sql);return {rows:healthyAnswers(c)(sql),error:null,overflow:false};}});
  const joined=sent.join('\n');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE)\b/.test(joined.replace(/has_table_privilege\([^)]*\)/g,'')),'no write or DDL statement');
  assert.ok(sent.filter(s=>/^BEGIN;/.test(s)).length>=6);assert.ok(sent.filter(s=>s==='ROLLBACK;').length>=sent.filter(s=>/^BEGIN;/.test(s)).length,'every scoped read ends in its own ROLLBACK');
});

// ---------------- the cases, run against a MODEL of the database (this tests the harness, not PostgreSQL) ----------------
const run=async({bugs={},world:w,over={},preflight,...rest}={})=>{
  const c=over.contract??contractOf(),world=w??createFakeWorld({contract:c,bugs,...(over.world??{})});
  const receipt=await runAcceptance({contract:c,factory:world.factory,control:over.noControl?undefined:world.control,clock:realClock,deadlineMs:over.deadlineMs??8000,preflight:preflight??(async()=>({passed:true,checks:[{id:'fake',ok:true,code:'ok'}]})),...rest});
  return {receipt,world,contract:c};
};
const byName=r=>Object.fromEntries(r.cases.map(c=>[c.name,c]));
test('against a correct model every required case passes, cleanup is certain, and only then is acceptance claimed',async()=>{
  const {receipt,world}=await run();
  assert.deepEqual(receipt.cases.map(c=>[c.name,c.status]),REQUIRED_CASE_NAMES.map(n=>[n,'PASS']),JSON.stringify(receipt.cases));
  assert.equal(receipt.accepted,true);assert.equal(receipt.status,'PASS');assert.equal(receipt.cleanup.certain,true);
  assert.equal(world.world.sessions.size,0,'every session this run opened was closed');assert.equal(world.world.locks.size,0,'no lock was left held');
  assert.equal(receipt.scope,OPT_IN_SCOPE);assert.equal(receipt.runMarker,RUN);
});
test('single outcomes in the model match the SQL the contract promises (sanity of the model itself)',async()=>{
  const {world}=await run();
  const cleared=[...world.world.holds.values()].filter(h=>!h.active);
  assert.ok(cleared.length>=7);assert.equal(world.world.evidence.length,world.world.receipts.length+0,'one evidence row per receipt');
  assert.ok(new Set(world.world.evidence.map(e=>e.holdId)).size===world.world.evidence.length,'at most one evidence row per hold');
  assert.deepEqual([...world.world.rules],[...Object.entries(contractOf().fixture.rules)],'rules were restored after the control case');
});
test('each wrong behaviour is caught by the case written for it (a defective model FAILS)',async()=>{
  const expectations={
    skipReplayRoleCheck:['roleOrRuleChangeBeforeReplay'],
    replayIgnoresRemovedRule:['roleOrRuleChangeBeforeReplay'],
    ignoreMembershipActive:['roleOrRuleChangeBeforeReplay'],
    allowDoubleClear:['differentKeyCompetingClear'],
    receiptsVisibleToAll:['actorPrivateConflict'],
    evidenceMutable:['sameKeyReplay'],
    claimIgnoresHold:['clearVersusClaimStackedAndNewHolds'],
  };
  for(const [bug,names] of Object.entries(expectations)){
    const {receipt}=await run({bugs:{[bug]:true}}),cases=byName(receipt);
    for(const name of names)assert.equal(cases[name].status,'FAIL',`${bug} should fail ${name}: ${JSON.stringify(cases[name])}`);
    assert.equal(receipt.accepted,false,bug);assert.equal(receipt.status,'FAIL');
  }
});
test('a failed preflight leaves every case NOT RUN and nothing is accepted',async()=>{
  const {receipt,world}=await run({preflight:async()=>({passed:false,checks:[{id:'rls_forced',ok:false,code:'rls_not_enabled_and_forced'}]})});
  assert.ok(receipt.cases.every(c=>c.status==='NOT RUN'&&c.code==='preflight_failed'));assert.equal(receipt.accepted,false);assert.equal(receipt.status,'FAIL');
  assert.equal(world.world.sessions.size,0,'the verifier was closed too');
  const cannot=await run({over:{world:{}},bugs:{cannotConnect:true}});
  assert.ok(cannot.receipt.cases.every(c=>c.status==='NOT RUN'));assert.equal(cannot.receipt.accepted,false);assert.equal(cannot.receipt.preflight.checks[0].code,'cannot_connect');
  const throwing=await run({preflight:async()=>{throw new Error('x');}});assert.equal(throwing.receipt.accepted,false);assert.ok(throwing.receipt.cases.every(c=>c.status==='NOT RUN'));
});
test('an incomplete fixture or a missing control makes cases NOT RUN, which is INCOMPLETE and never accepted',async()=>{
  const few=contractOf(r=>{r.fixture.holds=r.fixture.holds.filter(h=>!['EQ-P7','EQ-P8'].includes(h.equipmentId));});
  const a=await run({over:{contract:few}}),names=byName(a.receipt);
  assert.ok(Object.values(names).some(c=>c.status==='NOT RUN'&&c.code==='fixture_incomplete'));assert.equal(a.receipt.accepted,false);assert.equal(a.receipt.status,'INCOMPLETE');
  const noControl=await run({over:{noControl:true}}),n2=byName(noControl.receipt);
  assert.deepEqual([n2.roleOrRuleChangeBeforeReplay.status,n2.roleOrRuleChangeBeforeReplay.code],['NOT RUN','fixture_control_unavailable']);
  assert.equal(noControl.receipt.accepted,false);assert.equal(noControl.receipt.status,'INCOMPLETE');
  const noPair=contractOf(r=>{r.fixture.holds=r.fixture.holds.filter(h=>h.id!==U(121));});
  const p=await run({over:{contract:noPair}});assert.equal(byName(p.receipt).clearVersusClaimStackedAndNewHolds.status,'NOT RUN');assert.equal(p.receipt.accepted,false);
});
test('a case that never finishes is UNCERTAIN at the shared deadline, never a pass, and the run still cleans up',async()=>{
  const hang={name:'hangs',needs:{},async run(h){await h.open('a');return new Promise(()=>{});}};
  const {receipt,world}=await run({cases:[hang],over:{deadlineMs:150}});
  assert.deepEqual([receipt.cases[0].status,receipt.cases[0].code],['UNCERTAIN','deadline_exceeded']);assert.equal(receipt.accepted,false);
  assert.equal(world.world.sessions.size,0);
});
test('a timeout, a dying session or an unexpected error is UNCERTAIN; it is never a pass and cleanup still happens',async()=>{
  const slow=await run({over:{deadlineMs:40,world:{}}});         // far too short for the cases to finish
  assert.equal(slow.receipt.accepted,false);assert.ok(slow.receipt.cases.every(c=>c.status!=='PASS'||false)||slow.receipt.cases.some(c=>c.status==='UNCERTAIN'||c.status==='NOT RUN'));
  assert.equal(slow.world.world.sessions.size,0,'owned sessions are closed even after a timeout');
  const dying=await run({cases:[{name:'dies',needs:{},async run(h){const s=await h.open('a');await s.submit(beginAs(h.contract,'clearerA'),h.deadline);throw new SessionError('session_closed');}}]});
  assert.equal(dying.receipt.cases[0].status,'UNCERTAIN');assert.match(dying.receipt.cases[0].code,/^session_/);assert.equal(dying.receipt.accepted,false);
  const odd=await run({cases:[{name:'odd',needs:{},async run(){throw new TypeError('bug in the harness');}}]});assert.equal(odd.receipt.cases[0].status,'UNCERTAIN');assert.equal(odd.receipt.cases[0].code,'harness_error');
  const wrong=await run({cases:[{name:'wrong',needs:{},async run(){return {status:'MAYBE'};}}]});assert.equal(wrong.receipt.cases[0].status,'FAIL');
  const missing=await run({cases:CASES.slice(0,3)});assert.equal(missing.receipt.accepted,false,'a run that did not include every required case cannot be accepted');assert.equal(missing.receipt.status,'INCOMPLETE');
});
test('unconditional cleanup: open transactions are rolled back, owned handles closed, restore requested, and doubt is admitted',async()=>{
  const open={name:'leaks',needs:{},usesControl:true,async run(h){const s=await h.open('a');await s.submit(beginAs(h.contract,'clearerA'),h.deadline);await h.control.apply({action:'set-rule',kind:'fault',role:'viewer'});return {status:'PASS',code:'ok'};}};
  const clean=await run({cases:[open]});
  assert.equal(clean.receipt.cases[0].status,'PASS');assert.equal(clean.world.world.sessions.size,0);
  assert.deepEqual([...clean.world.world.rules].find(([k])=>k==='fault'),['fault','equipment_manager'],'the rule changed by the case was restored');
  assert.equal(clean.receipt.accepted,false,'one case is not the required set');
  const failedRestore=await run({cases:[open],over:{world:{failRestore:true}}});
  assert.equal(failedRestore.receipt.cases[0].status,'UNCERTAIN');assert.equal(failedRestore.receipt.cases[0].code,'cleanup_uncertain');assert.equal(failedRestore.receipt.cleanup.certain,false);
  const unsure=await run({over:{world:{closeProof:name=>({name,graceful:false,terminated:true,uncertain:true})}}});
  assert.equal(unsure.receipt.accepted,false);assert.equal(unsure.receipt.cleanup.certain,false);assert.ok(unsure.receipt.cases.every(c=>c.status!=='PASS'),'no case may pass when its cleanup is uncertain');
  const failedApply=await run({over:{world:{failApply:true}}});
  assert.deepEqual([byName(failedApply.receipt).roleOrRuleChangeBeforeReplay.status,byName(failedApply.receipt).roleOrRuleChangeBeforeReplay.code],['FAIL','fixture_control_failed'],'a refused control action stops the case');assert.equal(failedApply.receipt.accepted,false);
});
test('uncertain cleanup of the verifier, or a handle that was never closed, blocks acceptance even though every case passed',async()=>{
  const verifierDoubt=await run({over:{world:{closeProof:name=>name==='v'?{name,graceful:false,terminated:true,uncertain:true}:{name,graceful:true,terminated:false,uncertain:false}}}});
  assert.ok(verifierDoubt.receipt.cases.filter(c=>c.status==='PASS').length>=1);
  assert.equal(verifierDoubt.receipt.cleanup.certain,false);assert.equal(verifierDoubt.receipt.accepted,false,'verifier cleanup doubt');
  const leaked=await run({over:{world:{closeProof:name=>({name,graceful:true,terminated:false,uncertain:false})}}});     // claims a graceful close but the handle is still owned
  assert.ok(leaked.world.world.sessions.size>0);assert.equal(leaked.receipt.cleanup.certain,false);assert.equal(leaked.receipt.accepted,false,'a handle left open is reported');
});
test('an open transaction is rolled back by the runner itself, so its lock is released even if closing the handle does not',async()=>{
  const open={name:'leavesTxnOpen',needs:{},async run(h){const s=await h.open('a');await s.submit(beginAs(h.contract,'clearerA'),h.deadline);await s.submit(clearCall(prepareClear({holdId:h.takeHold('fault').id,reference:'LOG-1',observedAt:new Date(Date.now()-60000).toISOString()}),h.key('x')),h.deadline);return {status:'PASS',code:'ok'};}};
  const {world}=await run({cases:[open],over:{world:{closeKeepsTxn:true}}});
  assert.equal(world.world.locks.size,0,'the advisory lock taken inside the open transaction was released');
});
test('a case whose fixture needs cannot be met is NOT RUN before it opens anything; an extra failing case blocks acceptance',async()=>{
  const greedy={name:'greedy',needs:{holds:['fault','fault','fault','fault','fault','fault','fault','fault','fault']},async run(h){await h.open('a');return {status:'PASS',code:'ok'};}};
  const g=await run({cases:[greedy]});
  assert.deepEqual([g.receipt.cases[0].status,g.receipt.cases[0].code],['NOT RUN','fixture_incomplete']);assert.equal(g.world.world.opened,1,'only the verifier was ever opened');
  const extra={name:'extraFails',needs:{},async run(){return {status:'FAIL',code:'nope'};}};
  const all=await run({cases:[...CASES,extra]});
  assert.deepEqual(REQUIRED_CASE_NAMES.map(n=>byName(all.receipt)[n].status),REQUIRED_CASE_NAMES.map(()=>'PASS'));
  assert.equal(all.receipt.accepted,false,'one failing extra case is enough to refuse acceptance');assert.equal(all.receipt.status,'FAIL');
});
test('the receipt carries codes and counts only: no supplied path, host, database, role or secret appears in it',async()=>{
  const {receipt,contract}=await run();
  const text=JSON.stringify(redactedReceipt(receipt,contract));
  for(const needle of [contract.runtime.passfile,contract.runtime.psqlPath,contract.runtime.database,contract.runtime.runtimeRole,contract.runtime.expected.databaseOwner,'127.0.0.1'])assert.ok(!text.includes(needle),needle);
  assert.ok(!/SELECT|INSERT|password/i.test(text),'no SQL text');
});
test('a case that tries to reuse a consumed fixture item, or asks for an unsupported action, cannot pass',async()=>{
  const twice={name:'twice',needs:{holds:['fault']},async run(h){h.takeHold('fault');for(let i=0;i<20;i++)h.takeHold('fault');return {status:'PASS',code:'ok'};}};
  const r=await run({cases:[twice]});assert.equal(r.receipt.cases[0].status,'NOT RUN');assert.equal(r.receipt.cases[0].code,'fixture_incomplete');
  const bad={name:'bad',needs:{},usesControl:true,async run(h){await h.control.apply({action:'drop-database'});return {status:'PASS',code:'ok'};}};
  const b=await run({cases:[bad]});assert.equal(b.receipt.cases[0].status,'FAIL');assert.equal(b.receipt.cases[0].code,'bad_control_action');
});

// ---------------- structural guarantees: importing this suite can never connect ----------------
test('only one module in the harness imports child_process, and this suite loads it only after an explicit opt-in',()=>{
  const files=readdirSync(dir).filter(f=>f.endsWith('.mjs'));
  const importers=files.filter(f=>/child_process/.test(readFileSync(join(dir,f),'utf8')));
  assert.deepEqual(importers,['psql-spawn.mjs']);
  const self=readFileSync(fileURLToPath(import.meta.url),'utf8');
  assert.doesNotMatch(self,/^import .*child_process/m);assert.doesNotMatch(self,/^import .*psql-spawn/m);
  assert.ok(/await import\(pathToFileURL\(join\(dir,'psql-spawn\.mjs'\)\)/.test(self),'the real spawn is reached only through a dynamic import');
  // The old automatic-provisioning native test is not imported or executed by this suite (it is only ever read as text).
  assert.doesNotMatch(self,/import[^\n]*hold-race\.native/);
  for(const f of files){const src=readFileSync(join(dir,f),'utf8');assert.doesNotMatch(src,/process\.env/,`${f} reads no environment`);assert.doesNotMatch(src,/DATABASE_URL|PGPASSWORD|postgres:\/\//,f);}
  assert.doesNotMatch(readFileSync(join(dir,'session.mjs'),'utf8'),/pg_terminate_backend|pg_cancel_backend|kill -/,'no PID-based or global-session termination');
});
test('REQUIRED_ACTORS and the case list cover the contracted scenarios',()=>{
  assert.deepEqual([...REQUIRED_ACTORS].sort(),['clearerA','clearerA2','operator','outsider']);
  assert.deepEqual([...REQUIRED_CASE_NAMES],['sameKeyReplay','differentKeyCompetingClear','clearVersusClaimStackedAndNewHolds','rollbackInterleavings','roleOrRuleChangeBeforeReplay','actorPrivateConflict','tenantDenial']);
});

// ---------------- the native cases: INERT unless a supervised runner opts in explicitly ----------------
// The ONLY opt-in channel is one variable naming an absolute path to a contract file. Nothing else is read from the environment. If it is
// absent, the native test is SKIPPED (reported as skipped, never as passed). The supervised runner that owns the isolated database and the
// privileged fixture control should call runAcceptance() directly with its own control (see NATIVE-EVIDENCE.md); this convenience path has none,
// so the control-dependent case is NOT RUN here and the receipt is INCOMPLETE rather than accepted.
const OPT_IN_VARIABLE='SV_HOLD_EVIDENCE_NATIVE_CONFIG';
const optInPath=process.env[OPT_IN_VARIABLE];
test('NATIVE: hold-evidence concurrency acceptance against the supplied isolated synthetic database',{skip:optInPath?false:`NOT RUN: no explicit opt-in (${OPT_IN_VARIABLE}); native cases are inert and are not counted as passed`},async()=>{
  const contract=parseContract(JSON.parse(readFileSync(optInPath,'utf8')));       // validation first; a bad contract throws before anything connects
  const {realSpawn,realNonce,realClock:clock}=await import(pathToFileURL(join(dir,'psql-spawn.mjs')).href);
  const factory=createPsqlSessionFactory({contract,spawn:realSpawn,clock,newNonce:realNonce});
  const receipt=await runAcceptance({contract,factory,control:undefined,clock});
  console.log(JSON.stringify(redactedReceipt(receipt,contract)));
  assert.equal(receipt.accepted,true,`native acceptance not reached: ${receipt.status}`);
});
void STATUS;void uuidLit;
