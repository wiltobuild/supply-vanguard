// SV-034: fail-closed preflight. It READS facts from the supplied database through a verifier session and decides whether native cases may run.
// It never changes anything, never grants anything and never provisions. Results carry fixed codes only (no values, no SQL, no paths).
// Derived from the frozen migrations 0001 (core) / auth / requests / holds 0001-0003, including the intentional auth_user exception.
import {beginAs,lit,sigLit,uuidLit} from './sql.mjs';

// Relations whose row-level security must be enabled AND forced. auth_user is deliberately ENABLE-only (its resolver is the documented
// exception), so it is checked separately and must NOT be forced.
export const FORCED_RELATIONS=Object.freeze(['organization','equipment','equipment_hold','hold_clearance_rule','hold_clearance_evidence','hold_clearance_receipt','auth_membership','request','request_item','item_assignment']);
export const EVIDENCE_RELATIONS=Object.freeze(['hold_clearance_evidence','hold_clearance_receipt']);
export const FUNCTIONS=Object.freeze([
  'public.clear_equipment_hold_with_evidence(uuid,text,text,text,timestamptz,text)','public.clear_equipment_hold(uuid,text)',
  'public.place_equipment_hold(uuid,text,text,text)','public.claim_request_item(uuid,integer,uuid,integer,text)',
]);
export const nameOf=fn=>fn.slice(0,fn.indexOf('('));
const ALL_PROTECTED=[...FORCED_RELATIONS,'auth_user'];
const t=v=>v==='t'||v==='true';
const f=v=>v==='f'||v==='false';
const cells=row=>String(row??'').split('|');

// `query(sql)` must resolve to {rows:string[], error}. Rows are psql -At lines (columns separated by '|').
export async function runPreflight({contract,query}){
  const checks=[];
  const check=(id,ok,code)=>checks.push({id,ok:Boolean(ok),code:ok?'ok':code});
  const run=async(id,sql)=>{
    let res;
    try{res=await query(sql);}catch{check(id,false,'query_failed');return null;}
    if(!res||res.error||res.overflow){check(id,false,'query_error');return null;}
    return res.rows;
  };
  const r=contract.runtime;
  // psql reports the error status of the LAST statement only, so the ROLLBACK that ends a scoped read is its own submission.
  const scoped=async(id,actorName,sql)=>{const rows=await run(id,`${beginAs(contract,actorName)}\n${sql}`);try{await query('ROLLBACK;');}catch{/* the session is checked at cleanup */}return rows;};

  // 1. Exact server, database and identity.
  const ident=await run('identity',`SELECT current_database(), current_user, session_user, current_setting('server_version'), coalesce(host(inet_server_addr()),'-'), inet_server_port();`);
  if(ident?.length===1){
    const [db,cu,su,version,addr,port]=cells(ident[0]);
    check('database',db===r.database,'wrong_database');
    check('role',cu===r.runtimeRole&&su===r.runtimeRole,'wrong_role');
    check('server_version',version.startsWith(r.expected.serverVersionPrefix),'wrong_server_version');
    check('server_address',['127.0.0.1','::1'].includes(addr)&&String(port)===String(r.port),'not_the_supplied_loopback_server');
  }else if(ident)check('identity',false,'unexpected_shape');

  // 2. The runtime role has no elevated attribute, owns nothing protected and is a member of no owner role.
  const attrs=await run('role_attributes',`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = current_user;`);
  if(attrs?.length===1)check('role_attributes',cells(attrs[0]).every(f),'role_has_elevated_attribute');
  else if(attrs)check('role_attributes',false,'unexpected_shape');
  const owners=await run('ownership',`SELECT pg_get_userbyid(datdba) AS owner, 'database' FROM pg_database WHERE datname = current_database()
    UNION SELECT pg_get_userbyid(nspowner), 'schema' FROM pg_namespace WHERE nspname = 'public'
    UNION SELECT DISTINCT pg_get_userbyid(c.relowner), 'relation' FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${ALL_PROTECTED.map(lit).join(',')});`);
  if(owners){
    const names=[...new Set(owners.map(x=>cells(x)[0]))];
    let ok=names.length>0&&!names.includes(r.runtimeRole);
    check('owner_is_not_runtime_role',ok,'runtime_role_owns_protected_objects');
    const databaseOwner=owners.map(cells).find(c=>c[1]==='database')?.[0];
    check('database_owner',databaseOwner===r.expected.databaseOwner,'unexpected_database_owner');
    if(names.length){
      const members=await run('owner_membership',`SELECT ${names.map(n=>`pg_has_role(current_user, ${lit(n)}, 'MEMBER')`).join(', ')};`);
      check('not_member_of_owner_roles',members?.length===1&&cells(members[0]).every(f),'runtime_role_is_member_of_an_owner_role');
    }
  }

  // 3. Row-level security readiness derived from the frozen migrations.
  const rls=await run('rls',`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (${ALL_PROTECTED.map(lit).join(',')}) ORDER BY relname;`);
  if(rls){
    const byName=new Map(rls.map(x=>{const c=cells(x);return [c[0],c];}));
    const missing=ALL_PROTECTED.filter(n=>!byName.has(n));
    check('relations_present',missing.length===0,'protected_relation_missing');
    check('rls_forced',FORCED_RELATIONS.every(n=>byName.has(n)&&t(byName.get(n)[1])&&t(byName.get(n)[2])),'rls_not_enabled_and_forced');
    check('auth_user_exception',byName.has('auth_user')&&t(byName.get('auth_user')[1])&&f(byName.get('auth_user')[2]),'auth_user_exception_not_as_designed');
  }

  // 4. The evidence function is the corrected (0003) invoker function, and the runtime role has exactly the intended privileges.
  const fns=await run('functions',FUNCTIONS.map(fn=>`SELECT ${lit(nameOf(fn))}, p.prosecdef, position('SV-033' in p.prosrc) > 0 FROM pg_proc p WHERE p.oid = to_regprocedure(${sigLit(fn)});`).join('\n'));
  if(fns){
    const rows=fns.map(cells);
    check('functions_present',rows.length===FUNCTIONS.length,'function_missing');
    check('functions_are_invokers',rows.every(c=>f(c[1])),'function_is_security_definer');
    const evidenceFn=rows.find(c=>c[0]===nameOf(FUNCTIONS[0]));
    check('evidence_function_is_0003',Boolean(evidenceFn)&&t(evidenceFn[2]),'evidence_function_not_the_corrected_version');
  }
  const priv=await run('privileges',[
    ...EVIDENCE_RELATIONS.map(rel=>`SELECT ${lit(rel)}, ${['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'].map(p=>`has_table_privilege(current_user, ${lit('public.'+rel)}, ${lit(p)})`).join(', ')};`),
    `SELECT 'execute', has_function_privilege(current_user, to_regprocedure(${sigLit(FUNCTIONS[0])}), 'EXECUTE');`,
  ].join('\n'));
  if(priv){
    const byName=new Map(priv.map(x=>{const c=cells(x);return [c[0],c.slice(1)];}));
    const exact=EVIDENCE_RELATIONS.every(rel=>{const c=byName.get(rel);return Boolean(c)&&t(c[0])&&t(c[1])&&c.slice(2).every(f);});
    check('evidence_privileges_exact',exact,'evidence_privileges_not_select_and_insert_only');
    check('evidence_function_executable',byName.has('execute')&&t(byName.get('execute')[0]),'evidence_function_not_executable');
  }

  // 5. The supplied fixture really is what the contract says: tenants, actors with ACTIVE memberships and the configured roles, rules, holds.
  const fix=contract.fixture;
  for(const [orgKey,orgId] of Object.entries(fix.organizations)){
    const actorNames=Object.entries(fix.actors).filter(([,a])=>a.organization===orgKey).map(([n])=>n);
    const probe=actorNames[0];
    const org=await scoped(`organization_${orgKey}`,probe,`SELECT name, id FROM organization WHERE id = ${uuidLit(orgId)};`);
    check(`organization_${orgKey}`,org?.length===1&&cells(org[0])[0].includes(contract.runMarker),'organization_not_bound_to_run');
  }
  for(const [name,a] of Object.entries(fix.actors)){
    const m=await scoped(`actor_${name}`,name,`SELECT count(*) FROM auth_membership WHERE user_id = ${uuidLit(a.userId)} AND organization_id = ${uuidLit(fix.organizations[a.organization])} AND active AND role = ${lit(a.role)};`);
    check(`actor_${name}`,m?.length===1&&m[0]==='1','actor_membership_mismatch');
  }
  const rules=await scoped('rules','clearerA',`SELECT kind, role FROM hold_clearance_rule ORDER BY kind;`);
  if(rules){
    const got=Object.fromEntries(rules.map(x=>{const c=cells(x);return [c[0],c[1]];}));
    check('rules',Object.keys(fix.rules).every(k=>got[k]===fix.rules[k])&&Object.keys(got).length===Object.keys(fix.rules).length,'configured_rules_mismatch');
  }
  const holds=await scoped('holds','clearerA',`SELECT h.id, h.kind, e.external_id, h.active FROM equipment_hold h JOIN equipment e ON e.id = h.equipment_id AND e.organization_id = h.organization_id WHERE h.id IN (${fix.holds.map(h=>uuidLit(h.id)).join(',')}) ORDER BY h.id;`);
  if(holds){
    const got=new Map(holds.map(x=>{const c=cells(x);return [c[0],c];}));
    check('fixture_holds',fix.holds.every(h=>{const c=got.get(h.id);return Boolean(c)&&c[1]===h.kind&&c[2]===h.equipmentId&&t(c[3]);}),'fixture_holds_not_as_supplied');
  }
  if(fix.requests.length){
    const reqs=await scoped('fixture_requests','operator',`SELECT r.id, i.line_no, i.state FROM request r JOIN request_item i ON i.request_id = r.id AND i.organization_id = r.organization_id WHERE r.id IN (${fix.requests.map(x=>uuidLit(x.requestId)).join(',')});`);
    if(reqs){const got=new Set(reqs.map(x=>{const c=cells(x);return `${c[0]}:${c[1]}:${c[2]}`;}));check('fixture_requests',fix.requests.every(x=>got.has(`${x.requestId}:${x.line}:open`)),'fixture_requests_not_open');}
  }
  const passed=checks.length>0&&checks.every(c=>c.ok);
  return {passed,checks};
}
