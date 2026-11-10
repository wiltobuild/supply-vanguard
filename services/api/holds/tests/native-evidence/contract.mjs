// SV-034: the external contract for the OPT-IN native hold-evidence suite. Pure: no I/O, no environment, no connection.
// Everything the suite may touch is named here by the supervised runner. Nothing is discovered, defaulted or inherited:
//   - no connection string, password or token ever appears in the contract (secret-looking fields are rejected);
//   - the database password lives only in a runner-owned passfile that this code passes to psql by PATH and never reads;
//   - the target must be an isolated, synthetic, loopback database whose name is bound to the run marker.
// Error text is fixed and names a field path, never a supplied value.
import {ASSIGNABLE_ROLES,HOLD_KINDS} from '../../../../../packages/domain/holds/index.js';

export const OPT_IN_SCOPE='sv-034-hold-evidence-native';
export const CONTROL_CONTRACT='external-runner-v1';
export class ContractError extends Error {
  constructor(code,path=''){super(path?`${code}: ${path}`:code);this.name='ContractError';this.code=code;this.path=path;}
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_MARKER=/^svrun-[a-z0-9]{8,32}$/;
const IDENT=/^[a-z][a-z0-9_]{2,62}$/;
const EXTERNAL_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SECRET_FIELD=/pass(word|wd)?$|secret|token|credential|dsn|connection|conn(ection)?string|^url$|apikey|api_key/i;
export const LOOPBACK_HOSTS=Object.freeze(['127.0.0.1','::1','localhost']);
export const FORBIDDEN_ROLES=Object.freeze(['postgres','root','admin','superuser','sa']);
export const REQUIRED_ACTORS=Object.freeze(['clearerA','clearerA2','operator','outsider']);

const fail=(code,path)=>{throw new ContractError(code,path);};
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function exactKeys(value,allowed,path){
  if(!isObject(value))fail('not_an_object',path);
  for(const key of Object.keys(value)){
    if(SECRET_FIELD.test(key))fail('secret_field_refused',path);    // never name the key: it could itself be a secret
    if(!allowed.includes(key))fail('unknown_field',path);
  }
}
function absolutePath(value,path,basenames){
  if(typeof value!=='string'||value.length>260||!/^(\/|[A-Za-z]:[\\/])[A-Za-z0-9_ .\\/:~+-]*$/.test(value))fail('path_not_absolute',path);
  if(value.split(/[\\/]/).includes('..'))fail('path_traversal',path);
  const base=value.split(/[\\/]/).pop();
  if(basenames&&!basenames.includes(base))fail('path_wrong_file',path);
  return value;
}
const uuid=(v,path)=>{if(typeof v!=='string'||!UUID.test(v))fail('not_a_uuid',path);return v;};
const int=(v,min,max,path)=>{if(!Number.isInteger(v)||v<min||v>max)fail('out_of_range',path);return v;};

export function parseContract(raw){
  exactKeys(raw,['optIn','runtime','fixture'],'contract');
  // 1. Explicit, scoped approval. Merely having a file is not approval.
  exactKeys(raw.optIn,['approved','scope','runMarker'],'optIn');
  if(raw.optIn.approved!==true)fail('opt_in_not_approved','optIn.approved');
  if(raw.optIn.scope!==OPT_IN_SCOPE)fail('opt_in_wrong_scope','optIn.scope');
  const runMarker=raw.optIn.runMarker;
  if(typeof runMarker!=='string'||!RUN_MARKER.test(runMarker))fail('bad_run_marker','optIn.runMarker');

  // 2. The isolated synthetic target.
  const r=raw.runtime;
  exactKeys(r,['psqlPath','host','port','database','runtimeRole','passfile','expected','deadlineMs'],'runtime');
  const psqlPath=absolutePath(r.psqlPath,'runtime.psqlPath',['psql','psql.exe']);
  if(!LOOPBACK_HOSTS.includes(r.host))fail('host_not_loopback','runtime.host');
  const port=int(r.port,1024,65535,'runtime.port');
  const expectedDb=`sv_${runMarker.replace(/-/g,'_')}`;
  if(typeof r.database!=='string'||!IDENT.test(r.database)||r.database!==expectedDb)fail('database_not_bound_to_run','runtime.database');
  if(typeof r.runtimeRole!=='string'||!IDENT.test(r.runtimeRole)||FORBIDDEN_ROLES.includes(r.runtimeRole))fail('runtime_role_refused','runtime.runtimeRole');
  const passfile=absolutePath(r.passfile,'runtime.passfile',null);
  exactKeys(r.expected,['serverVersionPrefix','databaseOwner'],'runtime.expected');
  if(typeof r.expected.serverVersionPrefix!=='string'||!/^\d{2}\.$/.test(r.expected.serverVersionPrefix))fail('bad_version_prefix','runtime.expected.serverVersionPrefix');
  const databaseOwner=r.expected.databaseOwner;
  if(typeof databaseOwner!=='string'||!IDENT.test(databaseOwner)||databaseOwner===r.runtimeRole)fail('owner_must_differ_from_runtime_role','runtime.expected.databaseOwner');
  const deadlineMs=int(r.deadlineMs,1000,600000,'runtime.deadlineMs');

  // 3. The fictional fixture the runner provisioned.
  const f=raw.fixture;
  exactKeys(f,['organizations','actors','rules','holds','requests','control'],'fixture');
  exactKeys(f.organizations,['a','b'],'fixture.organizations');
  const organizations={a:uuid(f.organizations.a,'fixture.organizations.a'),b:uuid(f.organizations.b,'fixture.organizations.b')};
  if(organizations.a===organizations.b)fail('organizations_not_distinct','fixture.organizations');
  exactKeys(f.actors,REQUIRED_ACTORS,'fixture.actors');
  const actors={};
  for(const name of REQUIRED_ACTORS){
    const a=f.actors[name];exactKeys(a,['userId','organization','role'],`fixture.actors.${name}`);
    if(!['a','b'].includes(a.organization))fail('bad_organization','fixture.actors.'+name);
    if(!ASSIGNABLE_ROLES.includes(a.role))fail('bad_role','fixture.actors.'+name);
    actors[name]=Object.freeze({userId:uuid(a.userId,`fixture.actors.${name}.userId`),organization:a.organization,role:a.role});
  }
  if(new Set(Object.values(actors).map(a=>a.userId)).size!==REQUIRED_ACTORS.length)fail('actors_not_distinct','fixture.actors');
  if(actors.clearerA.organization!=='a'||actors.clearerA2.organization!=='a'||actors.operator.organization!=='a')fail('wrong_actor_organization','fixture.actors');
  if(actors.outsider.organization!=='b')fail('wrong_actor_organization','fixture.actors.outsider');
  if(actors.clearerA.role!==actors.clearerA2.role)fail('clearers_must_share_a_role','fixture.actors');
  exactKeys(f.rules,HOLD_KINDS,'fixture.rules');
  const rules={};
  for(const kind of HOLD_KINDS){if(!ASSIGNABLE_ROLES.includes(f.rules[kind]))fail('bad_role','fixture.rules.'+kind);rules[kind]=f.rules[kind];}
  if(rules.fault!==actors.clearerA.role||rules.maintenance!==actors.clearerA.role)fail('rules_do_not_match_clearers','fixture.rules');
  const holds=[];
  if(!Array.isArray(f.holds)||f.holds.length<1||f.holds.length>64)fail('bad_hold_pool','fixture.holds');
  for(const [i,h] of f.holds.entries()){
    exactKeys(h,['id','kind','equipmentId'],`fixture.holds[${i}]`);
    if(!HOLD_KINDS.includes(h.kind))fail('bad_kind',`fixture.holds[${i}]`);
    if(typeof h.equipmentId!=='string'||!EXTERNAL_ID.test(h.equipmentId))fail('bad_equipment_id',`fixture.holds[${i}]`);
    holds.push(Object.freeze({id:uuid(h.id,`fixture.holds[${i}].id`),kind:h.kind,equipmentId:h.equipmentId}));
  }
  if(new Set(holds.map(h=>h.id)).size!==holds.length)fail('duplicate_hold','fixture.holds');
  const requests=[];
  if(!Array.isArray(f.requests)||f.requests.length>16)fail('bad_request_pool','fixture.requests');
  for(const [i,q] of f.requests.entries()){
    exactKeys(q,['requestId','line','equipmentId'],`fixture.requests[${i}]`);
    if(typeof q.equipmentId!=='string'||!EXTERNAL_ID.test(q.equipmentId))fail('bad_equipment_id',`fixture.requests[${i}]`);
    requests.push(Object.freeze({requestId:uuid(q.requestId,`fixture.requests[${i}].requestId`),line:int(q.line,1,20,`fixture.requests[${i}].line`),equipmentId:q.equipmentId}));
  }
  if(f.control!==CONTROL_CONTRACT)fail('bad_control_contract','fixture.control');
  return Object.freeze({
    runMarker,
    runtime:Object.freeze({psqlPath,host:r.host,port,database:r.database,runtimeRole:r.runtimeRole,passfile,expected:Object.freeze({serverVersionPrefix:r.expected.serverVersionPrefix,databaseOwner}),deadlineMs}),
    fixture:Object.freeze({organizations:Object.freeze(organizations),actors:Object.freeze(actors),rules:Object.freeze(rules),holds:Object.freeze(holds),requests:Object.freeze(requests),control:CONTROL_CONTRACT}),
  });
}

// The ONLY way a session process is described. The environment is built from scratch: nothing is inherited, so no password, service,
// host, user or connection-string variable of the calling process can ever influence the target. psql gets `-w` so it can never prompt for a password.
export function buildPsqlInvocation(contract,sessionName){
  if(typeof sessionName!=='string'||!/^[a-z][a-z0-9]{0,15}$/.test(sessionName))fail('bad_session_name','sessionName');
  const r=contract.runtime;
  const appName=`${contract.runMarker}-${sessionName}`;
  return Object.freeze({
    command:r.psqlPath,
    args:Object.freeze(['-X','-q','-w','-At','-h',r.host,'-p',String(r.port),'-U',r.runtimeRole,'-d',r.database,'-v','ON_ERROR_STOP=0','-v','VERBOSITY=terse','-v','SHOW_CONTEXT=never']),
    env:Object.freeze({PGPASSFILE:r.passfile,PGAPPNAME:appName,PGCONNECT_TIMEOUT:'5',PGSSLMODE:'disable',PGOPTIONS:'-c statement_timeout=60000 -c lock_timeout=60000 -c idle_in_transaction_session_timeout=120000',LC_ALL:'C'}),
    options:Object.freeze({stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false}),
    appName,
  });
}

// Bounded text: output from sessions is never allowed to grow without limit.
export class BoundedText {
  constructor(limit=4096){this.limit=limit;this.parts=[];this.size=0;this.truncated=false;}
  push(chunk){
    const text=String(chunk);
    if(this.size>=this.limit){this.truncated=true;return;}
    const room=this.limit-this.size,piece=text.length>room?text.slice(0,room):text;
    if(piece.length<text.length)this.truncated=true;
    this.parts.push(piece);this.size+=piece.length;
  }
  toString(){return this.parts.join('');}
}
// Receipts and errors are redacted: the paths, host, port, database, role and run marker the runner supplied are replaced by tokens,
// absolute paths are removed, and the length is bounded.
export function redact(text,contract,limit=300){
  let out=String(text??'');
  if(contract){
    const r=contract.runtime,pairs=[[r.passfile,'<passfile>'],[r.psqlPath,'<psql>'],[r.database,'<database>'],[r.runtimeRole,'<role>'],[contract.runMarker,'<run>'],[`${r.host}:${r.port}`,'<server>']];
    for(const [needle,token] of pairs)if(needle)out=out.split(needle).join(token);
  }
  out=out.replace(/(?:[A-Za-z]:)?[\\/](?:[\w.~+-]+[\\/])+[\w.~+-]*/g,'<path>');
  return out.length>limit?out.slice(0,limit)+'…':out;
}
