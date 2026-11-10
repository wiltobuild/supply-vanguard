// SV-034: an in-memory MODEL of the parts of the database the native cases exercise, used ONLY to test the harness itself.
// It is not a database and proves nothing about PostgreSQL: it lets the orchestration (lock waits, commit/rollback ordering, outcome
// checks, cleanup, failure classification) run with no process, no connection and no credentials. It interprets exactly the statements
// that sql.mjs builds. `bugs` switches on deliberate defects so the cases can be shown to FAIL when the behaviour is wrong.
import {withDeadline} from './session.mjs';

const ERRORS={no_tenant_context:'42501',hold_not_found:'SV404',idempotency_conflict:'SV409',hold_already_cleared:'SV409',no_clearance_rule:'SV422',wrong_role:'SV403',evidence_invalid:'SV422',equipment_on_hold:'SV422'};
class Db extends Error {constructor(code,sqlstate,message){super(message??`sv:${code}`);this.sqlstate=sqlstate??ERRORS[code]??'XX000';}}
let counter=0;
const uid=()=>`00000000-0000-4000-8000-${String(++counter).padStart(12,'0')}`;

export function createFakeWorld({contract,wall=()=>Date.now(),bugs={},failRestore=false,failApply=false,closeProof=null,closeKeepsTxn=false}){
  const f=contract.fixture;
  const world={
    memberships:new Map(Object.values(f.actors).map(a=>[a.userId,{org:f.organizations[a.organization],role:a.role,active:true}])),
    rules:new Map(Object.entries(f.rules)),
    holds:new Map(f.holds.map(h=>[h.id,{id:h.id,org:f.organizations.a,equipment:h.equipmentId,kind:h.kind,active:true,clearedBy:null}])),
    evidence:[],receipts:[],assignments:[],
    equipment:new Map([...new Set([...f.holds.map(h=>h.equipmentId),...f.requests.map(r=>r.equipmentId)])].map(e=>[e,{uuid:uid(),version:0,org:f.organizations.a}])),
    locks:new Map(),sessions:new Set(),opened:0,
  };
  const initial={memberships:structuredClone([...world.memberships]),rules:structuredClone([...world.rules])};
  const actorOf=ctx=>world.memberships.get(ctx.user);
  const visible=ctx=>{const m=ctx.user&&actorOf(ctx);return Boolean(m&&(m.active||bugs.ignoreMembershipActive)&&m.org===ctx.org);};   // inventory:read in the context tenant

  // ---- locks (per-hold advisory transaction locks) ----
  const release=session=>{
    for(const [key,lock] of [...world.locks]){
      if(lock.owner!==session)continue;
      const next=lock.queue.shift();
      if(next){lock.owner=next.session;next.session.waiting=false;next.grant();}else world.locks.delete(key);
    }
  };
  const acquire=(session,key)=>{
    const lock=world.locks.get(key);
    if(!lock){world.locks.set(key,{owner:session,queue:[]});return Promise.resolve();}
    if(lock.owner===session)return Promise.resolve();
    return new Promise(grant=>{session.waiting=true;lock.queue.push({session,grant});});
  };

  // ---- transaction views: committed state plus this transaction's own staged changes ----
  const stage=()=>({holds:new Map(),evidence:[],receipts:[],assignments:[]});
  const merged=(s)=>({
    holds:[...world.holds.values()].map(h=>({...h,...(s.txn?.staged.holds.get(h.id)??{})})).concat([...(s.txn?.staged.holds.values()??[])].filter(h=>!world.holds.has(h.id))),
    evidence:[...world.evidence,...(s.txn?.staged.evidence??[])],
    receipts:[...world.receipts,...(s.txn?.staged.receipts??[])],
    assignments:[...world.assignments,...(s.txn?.staged.assignments??[])],
  });
  const commit=s=>{
    const st=s.txn.staged;
    for(const [id,patch] of st.holds){const cur=world.holds.get(id);world.holds.set(id,cur?{...cur,...patch}:{...patch});}
    world.evidence.push(...st.evidence);world.receipts.push(...st.receipts);world.assignments.push(...st.assignments);
  };
  const endTxn=(s,doCommit)=>{if(s.txn&&doCommit&&!s.txn.aborted)commit(s);s.txn=null;release(s);};

  // ---- the statements the cases send ----
  async function clearFn(s,[holdId,key,hash,reference,observedAt,note]){
    const ctx=s.ctx;
    if(!ctx.org||!ctx.user)throw new Db('no_tenant_context');
    await acquire(s,`hold:${holdId}`);
    const v=merged(s),actor=`user:${ctx.user}`;
    const hold=visible(ctx)?v.holds.find(h=>h.id===holdId&&h.org===ctx.org):null;
    if(!hold)throw new Db('hold_not_found');
    const rule=world.rules.get(hold.kind),mine=world.memberships.get(ctx.user);
    const roleCheck=(replay=false)=>{if(!rule&&replay&&bugs.replayIgnoresRemovedRule)return;if(!rule)throw new Db('no_clearance_rule');if(!(mine.active&&mine.role===rule))throw new Db('wrong_role');};
    const receipt=v.receipts.find(r=>r.key===key&&r.org===ctx.org&&(bugs.receiptsVisibleToAll||r.actor===actor));
    if(receipt){
      if(!bugs.skipReplayRoleCheck)roleCheck(true);
      if(receipt.hash===hash&&receipt.holdId===holdId)return {holdId:receipt.holdId,evidenceId:receipt.evidenceId,cleared:true,replayed:true};
      throw new Db('idempotency_conflict');
    }
    if(!hold.active&&!bugs.allowDoubleClear)throw new Db('hold_already_cleared');
    roleCheck();
    if(Date.parse(observedAt)>wall())throw new Db('evidence_invalid');
    const evidenceId=uid();
    s.txn.staged.holds.set(holdId,{...hold,active:false,clearedBy:actor});
    s.txn.staged.evidence.push({id:evidenceId,holdId,reference,recordedBy:actor});
    if(v.receipts.some(r=>r.key===key&&r.org===ctx.org))throw new Db('idempotency_conflict');
    s.txn.staged.receipts.push({key,org:ctx.org,actor,hash,holdId,evidenceId});
    return {holdId,evidenceId,cleared:true,replayed:false};
  }
  function placeFn(s,[eqUuid,kind]){
    const ctx=s.ctx,v=merged(s),eq=[...world.equipment].find(([,e])=>e.uuid===eqUuid);
    if(!eq||!visible(ctx))throw new Db('hold_not_found');
    const ext=eq[0],existing=v.holds.find(h=>h.equipment===ext&&h.kind===kind&&h.active);
    if(existing)return {holdId:existing.id,placed:false};
    const id=uid();s.txn.staged.holds.set(id,{id,org:ctx.org,equipment:ext,kind,active:true,clearedBy:null});
    return {holdId:id,placed:true};
  }
  function claimFn(s,[,,eqUuid]){
    const ctx=s.ctx,v=merged(s),eq=[...world.equipment].find(([,e])=>e.uuid===eqUuid);
    if(!eq||!visible(ctx))throw new Db('hold_not_found');
    if(!bugs.claimIgnoresHold&&v.holds.some(h=>h.equipment===eq[0]&&h.active))throw new Db('equipment_on_hold');
    const assignmentId=uid();s.txn.staged.assignments.push({equipment:eqUuid,assignmentId});
    return {assignmentId,replayed:false};
  }
  const unquote=x=>x.replace(/^'|'$/g,'');
  const args=text=>[...text.matchAll(/'([^']*)'(?:::\w+)?|NULL|(\d+)/g)].map(m=>m[1]!==undefined?m[1]:m[2]!==undefined?Number(m[2]):null);

  async function statement(s,sql){
    let m;
    if(/^BEGIN$/.test(sql)){if(s.txn){return {rows:[]};}s.txn={staged:stage(),aborted:false};s.ctx={};return {rows:[]};}
    if(/^COMMIT$/.test(sql)||/^ROLLBACK$/.test(sql)){endTxn(s,/^COMMIT$/.test(sql));return {rows:[]};}
    if(s.txn?.aborted)throw new Db('aborted',  '25P02','current transaction is aborted, commands ignored until end of transaction block');
    if((m=/^SET LOCAL sv\.(user_id|organization_id) = '([^']+)'$/.exec(sql))){s.ctx[m[1]==='user_id'?'user':'org']=m[2];return {rows:[]};}
    if(/^SELECT pg_backend_pid\(\)$/.test(sql))return {rows:[String(s.pid)]};
    const v=()=>merged(s),ctx=s.ctx??{};
    if((m=/^SELECT public\.clear_equipment_hold_with_evidence\((.*)\)$/.exec(sql))){const r=await clearFn(s,args(m[1]));return {rows:[JSON.stringify(r)]};}
    if((m=/^SELECT public\.place_equipment_hold\((.*)\)$/.exec(sql)))return {rows:[JSON.stringify(placeFn(s,args(m[1])))]};
    if((m=/^SELECT public\.claim_request_item\((.*)\)$/.exec(sql)))return {rows:[JSON.stringify(claimFn(s,args(m[1])))]};
    if((m=/^SELECT id, reference, recorded_by FROM hold_clearance_evidence WHERE hold_id = '([^']+)'::uuid ORDER BY id$/.exec(sql))){
      const hold=v().holds.find(h=>h.id===m[1]);
      return {rows:visible(ctx)&&hold&&hold.org===ctx.org?v().evidence.filter(e=>e.holdId===m[1]).map(e=>`${e.id}|${e.reference}|${e.recordedBy}`):[]};
    }
    if((m=/^SELECT hold_id, evidence_id, actor FROM hold_clearance_receipt WHERE idempotency_key = '([^']+)' ORDER BY id$/.exec(sql)))
      return {rows:visible(ctx)?v().receipts.filter(r=>r.key===m[1]&&r.org===ctx.org&&(bugs.receiptsVisibleToAll||r.actor===`user:${ctx.user}`)).map(r=>`${r.holdId}|${r.evidenceId}|${r.actor}`):[]};
    if((m=/^SELECT active, kind, coalesce\(cleared_by, '-'\) FROM equipment_hold WHERE id = '([^']+)'::uuid$/.exec(sql))){
      const h=v().holds.find(x=>x.id===m[1]);return {rows:visible(ctx)&&h&&h.org===ctx.org?[`${h.active?'t':'f'}|${h.kind}|${h.clearedBy??'-'}`]:[]};
    }
    if((m=/^SELECT h\.kind FROM equipment_hold h JOIN equipment e .* WHERE e\.external_id = '([^']+)' AND h\.active ORDER BY h\.kind$/.exec(sql)))
      return {rows:visible(ctx)?v().holds.filter(h=>h.equipment===m[1]&&h.active&&h.org===ctx.org).map(h=>h.kind).sort():[]};
    if((m=/^SELECT id, version FROM equipment WHERE external_id = '([^']+)'$/.exec(sql))){const e=world.equipment.get(m[1]);return {rows:visible(ctx)&&e?[`${e.uuid}|${e.version}`]:[]};}
    if((m=/^SELECT count\(\*\) FROM item_assignment WHERE equipment_id = '([^']+)'::uuid AND active$/.exec(sql)))return {rows:[String(v().assignments.filter(a=>a.equipment===m[1]).length)]};
    if(/^UPDATE hold_clearance_evidence SET reference = 'TAMPERED'/.test(sql)){
      if(bugs.evidenceMutable){world.evidence.forEach(e=>{e.reference='TAMPERED';});return {rows:[]};}
      throw new Db('denied','42501','permission denied for table hold_clearance_evidence');
    }
    if(/^DELETE FROM hold_clearance_receipt WHERE idempotency_key = /.test(sql))throw new Db('denied','42501','permission denied for table hold_clearance_receipt');
    if((m=/^SELECT count\(\*\) FROM pg_stat_activity WHERE application_name = '([^']+)'/.exec(sql)))
      return {rows:[String([...world.sessions].filter(x=>x.appName===m[1]&&x.waiting).length)]};
    throw new Db('unsupported','XX000',`unsupported statement in the fake world: ${sql.slice(0,40)}`);
  }
  // psql semantics: statements run in order, errors do not stop the batch, and ERROR/SQLSTATE describe the LAST statement.
  async function exec(s,sql){
    const rows=[];let last=null;
    for(const raw of sql.split(/;\s*(?:\n|$)/).map(x=>x.trim()).filter(Boolean)){
      try{const r=await statement(s,raw);rows.push(...r.rows);last=null;}
      catch(e){
        if(!(e instanceof Db))throw e;
        if(s.txn&&e.sqlstate!=='25P02')s.txn.aborted=true;
        last={sqlstate:e.sqlstate,message:e.message};
      }
    }
    return {rows,error:last,overflow:false};
  }
  let pidCounter=40000;
  const factory={
    ownedHandles:()=>[...world.sessions],
    async open(name,deadline){
      if(bugs.cannotConnect)throw new Error('refused');
      const s={name,pid:++pidCounter,appName:`${contract.runMarker}-${name}`,txn:null,ctx:{},waiting:false,tail:Promise.resolve(),closed:false,tainted:false};
      world.sessions.add(s);world.opened++;
      const session={
        name,appName:s.appName,pid:s.pid,
        isOpen:()=>!s.closed,isTainted:()=>s.tainted,stderrSummary:()=>'',
        submit(sql,dl){
          if(s.closed)return Promise.reject(Object.assign(new Error('session_closed'),{name:'SessionError',code:'session_closed'}));
          const run=()=>withDeadline(exec(s,sql),dl,`${name}:submit`).catch(e=>{if(e?.name==='TimeoutError')s.tainted=true;throw e;});
          const out=s.tail.then(run,run);s.tail=out.then(()=>{},()=>{});return out;
        },
        async close(){
          if(closeProof)return closeProof(name);
          if(!closeKeepsTxn)endTxn(s,false);s.closed=true;world.sessions.delete(s);return {name,graceful:true,terminated:false,uncertain:false};
        },
      };
      s.handle=session;
      return session;
    },
  };
  const control={
    async apply(action){
      if(failApply)return {ok:false};
      if(action.action==='restore'){
        if(failRestore)return {ok:false};
        world.memberships=new Map(structuredClone(initial.memberships));world.rules=new Map(structuredClone(initial.rules));return {ok:true,proof:'restored'};
      }
      if(action.action==='set-rule'){world.rules.set(action.kind,action.role);return {ok:true};}
      if(action.action==='remove-rule'){world.rules.delete(action.kind);return {ok:true};}
      const userId=f.actors[action.actor].userId,m=world.memberships.get(userId);
      if(action.action==='set-membership-role'){m.role=action.role;return {ok:true};}
      if(action.action==='set-membership-active'){m.active=action.active;return {ok:true};}
      return {ok:false};
    },
  };
  return {world,factory,control};
}
