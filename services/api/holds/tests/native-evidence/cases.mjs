// SV-034: the REQUIRED native cases for hold-clearance evidence. Each case is a deterministic script over real, separate sessions:
// one session holds the per-hold advisory lock inside an OPEN transaction, the next session is observed WAITING on that lock, and only then
// is the first one committed or rolled back. No sleeps decide an outcome. Every case ends by asserting exact SQL outcomes.
// A case never sets up or tears down the database: it consumes fictional fixture items the runner provisioned, and it reports a PASS only
// when every assertion held. The harness (runner.mjs) turns any other outcome into FAIL, NOT RUN or UNCERTAIN, never into a pass.
import {HOLD_KINDS,ASSIGNABLE_ROLES} from '../../../../../packages/domain/holds/index.js';
import {REQUIRED_ACTORS} from './contract.mjs';
import {COMMIT,ROLLBACK,beginAs,claimCall,clearCall,clearOpen,prepareClear,q,actorString,lit,uuidLit,parseJsonCell,svCode} from './sql.mjs';

export class CaseFail extends Error {constructor(code){super(code);this.name='CaseFail';this.code=code;}}
const must=(condition,code)=>{if(!condition)throw new CaseFail(code);};

// The only things the harness may ask the supervised runner to change (privileged setup stays with the runner). Bounded, fictional, validated.
export const CONTROL_ACTIONS=Object.freeze(['set-rule','remove-rule','set-membership-role','set-membership-active','restore']);
export function validateControlAction(a){
  const ok=a&&typeof a==='object'&&CONTROL_ACTIONS.includes(a.action);
  if(!ok)throw new CaseFail('bad_control_action');
  const only=keys=>{if(Object.keys(a).some(k=>k!=='action'&&!keys.includes(k)))throw new CaseFail('bad_control_action');};
  if(a.action==='set-rule'){only(['kind','role']);must(HOLD_KINDS.includes(a.kind)&&ASSIGNABLE_ROLES.includes(a.role),'bad_control_action');}
  else if(a.action==='remove-rule'){only(['kind']);must(HOLD_KINDS.includes(a.kind),'bad_control_action');}
  else if(a.action==='set-membership-role'){only(['actor','role']);must(REQUIRED_ACTORS.includes(a.actor)&&ASSIGNABLE_ROLES.includes(a.role),'bad_control_action');}
  else if(a.action==='set-membership-active'){only(['actor','active']);must(REQUIRED_ACTORS.includes(a.actor)&&typeof a.active==='boolean','bad_control_action');}
  else{only(['scope']);must(['case','all'].includes(a.scope),'bad_control_action');}
  return a;
}

// ---- helpers shared by the cases ----
const outcome=res=>{                       // a statement's result as {ok, value?, code?}
  if(res.error)return {ok:false,code:svCode(res.error.message)??`db_${res.error.sqlstate||'error'}`,sqlstate:res.error.sqlstate};
  const value=parseJsonCell(res.rows[0]??'');
  return value?{ok:true,value}:{ok:true,value:null,rows:res.rows};
};
const evidenceRows=async(h,actor,holdId)=>(await h.read(actor,q.evidenceForHold(holdId))).rows.map(r=>r.split('|'));
const receiptRows=async(h,actor,key)=>(await h.read(actor,q.receiptsForKey(key))).rows.map(r=>r.split('|'));
const holdState=async(h,actor,holdId)=>((await h.read(actor,q.holdState(holdId))).rows[0]??'').split('|');
const activeKinds=async(h,actor,eq)=>(await h.read(actor,q.activeHoldKinds(eq))).rows;
const ctxOf=h=>h.contract;
const prep=(h,hold,label,extra={})=>prepareClear({holdId:hold.id,reference:`LOG-${h.marker}-${label}`,observedAt:h.observedAt(),note:`native ${label}`,...extra},h.wallNow());
// Starts a clear in an OPEN transaction (the advisory lock is held until the transaction ends) and returns its parsed result.
async function openClear(h,session,actor,p,key,orgKey){
  return outcome(await session.submit(clearOpen(ctxOf(h),actor,p,key,orgKey),h.deadline));
}
async function finishTxn(h,session,verb){return session.submit(verb,h.deadline);}
// SV-036: compare EVERYTHING persisted for one clearance with the exact prepared request and the identities the harness expects: schema version,
// reference, observed time, note, tenant, hold, recording actor, the receipt's link to that evidence, its actor and its request hash. A single
// mismatch is a failure with its own code. The returned evidence id must also be the persisted one (replay identity) when it is supplied.
async function assertPersisted(h,actorName,{hold,p,key,evidenceId}){
  const fx=h.contract.fixture,actor=fx.actors[actorName],org=fx.organizations[actor.organization],who=actorString(actor.userId);
  const ev=(await h.read(actorName,q.evidenceDetail(hold.id))).rows.map(r=>r.split('|'));
  must(ev.length===1,'persisted_evidence_count');
  const [id,evOrg,evHold,schema,reference,observedAt,noteIsNull,note,recordedBy]=ev[0];
  must(schema==='1','persisted_schema_version');
  must(reference===p.reference,'persisted_reference');
  must(Number.isFinite(Date.parse(observedAt))&&Date.parse(observedAt)===Date.parse(p.observedAt),'persisted_observed_at');
  must(p.note===null?noteIsNull==='t':noteIsNull==='f'&&note===p.note,'persisted_note');
  must(evHold===hold.id,'persisted_hold');
  must(evOrg===org,'persisted_tenant');
  must(recordedBy===who,'persisted_actor');
  if(evidenceId!==undefined)must(id===evidenceId,'persisted_evidence_identity');
  const rc=(await h.read(actorName,q.receiptDetail(key))).rows.map(r=>r.split('|'));
  must(rc.length===1,'persisted_receipt_count');
  const [rHold,rEvidence,rActor,rHash,rOrg]=rc[0];
  must(rHold===hold.id&&rEvidence===id&&rActor===who&&rOrg===org,'persisted_receipt_link');
  must(rHash===p.hash,'persisted_receipt_hash');
}
// Immutable evidence: the runtime role can neither rewrite nor delete what was recorded.
async function assertImmutable(h,actor,holdId,key){
  const upd=await h.read(actor,q.tryUpdateEvidence(holdId));
  must(Boolean(upd.error)&&upd.error.sqlstate==='42501','evidence_update_not_refused');
  const del=await h.read(actor,q.tryDeleteReceipt(key));
  must(Boolean(del.error)&&del.error.sqlstate==='42501','receipt_delete_not_refused');
  const rows=await evidenceRows(h,actor,holdId);
  must(rows.length===1&&rows[0][1]!=='TAMPERED','evidence_changed');
}

export const CASES=Object.freeze([
  {
    name:'sameKeyReplay',needs:{holds:['fault']},
    // Two real sessions, the same actor, the same key and payload. The second must wait, then replay the first's result.
    async run(h){
      const hold=h.takeHold('fault'),key=h.key('k1'),p=prep(h,hold,'a');
      const A=await h.open('a'),B=await h.open('b');
      const a=await openClear(h,A,'clearerA',p,key);
      must(a.ok&&a.value?.replayed===false&&a.value.cleared===true,'first_clear_failed');
      const pendingB=B.submit(clearOpen(ctxOf(h),'clearerA',p,key),h.deadline);
      await h.waitQueued(B);
      await finishTxn(h,A,COMMIT);
      const b=outcome(await pendingB);
      must(b.ok&&b.value?.replayed===true&&b.value.evidenceId===a.value.evidenceId,'replay_did_not_return_the_original');
      await finishTxn(h,B,COMMIT);
      must((await evidenceRows(h,'clearerA',hold.id)).length===1,'evidence_not_single');
      const receipts=await receiptRows(h,'clearerA',key);
      must(receipts.length===1&&receipts[0][1]===a.value.evidenceId,'receipt_not_single');
      const st=await holdState(h,'clearerA',hold.id);
      must(st[0]==='f'&&st[2]===actorString(h.contract.fixture.actors.clearerA.userId),'hold_not_cleared_by_the_actor');
      await assertPersisted(h,'clearerA',{hold,p,key,evidenceId:a.value.evidenceId});
      await assertImmutable(h,'clearerA',hold.id,key);
      return {status:'PASS',code:'ok'};
    },
  },
  {
    name:'differentKeyCompetingClear',needs:{holds:['fault']},
    // Two actors with the clearing role race for one hold with different keys. Exactly one clearance may exist.
    async run(h){
      const hold=h.takeHold('fault'),k1=h.key('k1'),k2=h.key('k2'),p1=prep(h,hold,'a'),p2=prep(h,hold,'b');
      const A=await h.open('a'),B=await h.open('b');
      const a=await openClear(h,A,'clearerA',p1,k1);must(a.ok&&a.value?.replayed===false,'first_clear_failed');
      const pendingB=B.submit(clearOpen(ctxOf(h),'clearerA2',p2,k2),h.deadline);
      await h.waitQueued(B);
      await finishTxn(h,A,COMMIT);
      const b=outcome(await pendingB);
      must(!b.ok&&b.code==='hold_already_cleared','competing_clear_not_refused');
      await finishTxn(h,B,ROLLBACK);
      const ev=await evidenceRows(h,'clearerA',hold.id);
      must(ev.length===1&&ev[0][2]===actorString(h.contract.fixture.actors.clearerA.userId),'not_exactly_one_clearance');
      must((await receiptRows(h,'clearerA',k1)).length===1&&(await receiptRows(h,'clearerA2',k2)).length===0,'receipts_wrong');
      await assertPersisted(h,'clearerA',{hold,p:p1,key:k1,evidenceId:a.value.evidenceId});          // the winner's request, not the loser's
      return {status:'PASS',code:'ok'};
    },
  },
  {
    name:'clearVersusClaimStackedAndNewHolds',needs:{stackedPair:['fault','maintenance'],single:true},
    // Clearing one of several holds, or the last hold, never lets a claim through before commit; a NEW hold placed meanwhile stays independent.
    async run(h){
      const {first,second,request}=h.takeStackedPair('fault','maintenance');
      const eq=(await h.read('operator',q.equipmentByExternalId(first.equipmentId))).rows[0]?.split('|');
      must(Boolean(eq),'equipment_not_found');
      const claim=()=>claimCall(request.requestId,request.line,eq[0],Number(eq[1]),actorString(h.contract.fixture.actors.operator.userId));
      const p=prep(h,first,'s1'),key=h.key('k1');
      const A=await h.open('a'),P=await h.open('p'),C=await h.open('c');
      const a=await openClear(h,A,'clearerA',p,key);must(a.ok&&a.value?.replayed===false,'first_clear_failed');
      // A new, independent hold on the same equipment while the clear is still open.
      const placed=outcome(await P.submit(`${beginAs(ctxOf(h),'operator')}\nSELECT public.place_equipment_hold(${uuidLit(eq[0])}, 'dirty', ${lit('native new hold')}, ${lit(actorString(h.contract.fixture.actors.operator.userId))});\n${COMMIT}`,h.deadline));
      must(placed.ok&&placed.value?.placed===true,'new_hold_not_placed');
      const c1=outcome(await C.submit(`${beginAs(ctxOf(h),'operator')}\n${claim()}`,h.deadline));
      must(!c1.ok&&c1.code==='equipment_on_hold','claim_not_refused_while_stacked');
      await finishTxn(h,C,ROLLBACK);
      await finishTxn(h,A,COMMIT);
      must((await evidenceRows(h,'clearerA',first.id)).length===1,'evidence_not_single');
      await assertPersisted(h,'clearerA',{hold:first,p,key,evidenceId:a.value.evidenceId});
      const kinds=await activeKinds(h,'clearerA',first.equipmentId);
      must(kinds.join(',')==='dirty,maintenance','stack_not_independent');          // explicitly the CURRENT state, not part of the receipt
      must((await holdState(h,'clearerA',second.id))[0]==='t','other_hold_was_cleared');
      const c2=outcome(await C.submit(`${beginAs(ctxOf(h),'operator')}\n${claim()}`,h.deadline));
      must(!c2.ok&&c2.code==='equipment_on_hold','claim_not_refused_after_commit');
      await finishTxn(h,C,ROLLBACK);
      // The last hold: a claim sees the uncommitted clear as not done, and succeeds exactly once after the commit.
      const single=h.takeSingle(),sEq=(await h.read('operator',q.equipmentByExternalId(single.hold.equipmentId))).rows[0]?.split('|');
      must(Boolean(sEq),'equipment_not_found');
      const sClaim=()=>claimCall(single.request.requestId,single.request.line,sEq[0],Number(sEq[1]),actorString(h.contract.fixture.actors.operator.userId));
      const sp=prep(h,single.hold,'s2'),sKey=h.key('k2');
      const A2=await h.open('a2'),C2=await h.open('c2');
      const s=await openClear(h,A2,'clearerA',sp,sKey);must(s.ok&&s.value?.replayed===false,'last_clear_failed');
      const early=outcome(await C2.submit(`${beginAs(ctxOf(h),'operator')}\n${sClaim()}`,h.deadline));
      must(!early.ok&&early.code==='equipment_on_hold','claim_slipped_through_an_uncommitted_clear');
      await finishTxn(h,C2,ROLLBACK);
      await finishTxn(h,A2,COMMIT);
      const late=outcome(await C2.submit(`${beginAs(ctxOf(h),'operator')}\n${sClaim()}`,h.deadline));
      must(late.ok&&Boolean(late.value?.assignmentId),'claim_refused_after_the_last_hold_was_cleared');
      await finishTxn(h,C2,COMMIT);
      must((await h.read('operator',q.assignmentsForEquipment(sEq[0]))).rows[0]==='1','assignment_not_exactly_one');
      must((await evidenceRows(h,'clearerA',single.hold.id)).length===1,'evidence_not_single');
      await assertPersisted(h,'clearerA',{hold:single.hold,p:sp,key:sKey,evidenceId:s.value.evidenceId});
      return {status:'PASS',code:'ok'};
    },
  },
  {
    name:'rollbackInterleavings',needs:{holds:['fault','fault']},
    // A waiting session proceeds as a first-time clear when the holder rolls back; a failing call stores nothing at all.
    async run(h){
      const h1=h.takeHold('fault'),h2=h.takeHold('fault'),k1=h.key('k1'),k2=h.key('k2');
      const A=await h.open('a'),B=await h.open('b');
      const p1=prep(h,h1,'r1');
      const a=await openClear(h,A,'clearerA',p1,k1);must(a.ok,'first_clear_failed');
      const pendingB=B.submit(clearOpen(ctxOf(h),'clearerA',p1,k1),h.deadline);
      await h.waitQueued(B);
      await finishTxn(h,A,ROLLBACK);
      const b=outcome(await pendingB);
      must(b.ok&&b.value?.replayed===false&&b.value.evidenceId!==a.value.evidenceId,'waiter_did_not_become_the_first_clear');
      await finishTxn(h,B,COMMIT);
      const ev=await evidenceRows(h,'clearerA',h1.id);
      must(ev.length===1&&ev[0][0]===b.value.evidenceId,'rolled_back_evidence_survived');
      must((await receiptRows(h,'clearerA',k1)).length===1,'receipt_not_single');
      await assertPersisted(h,'clearerA',{hold:h1,p:p1,key:k1,evidenceId:b.value.evidenceId});
      // A raised error (evidence from the future) stores nothing and leaves the hold active; the next attempt succeeds.
      const bad={...prep(h,h2,'r2'),observedAt:new Date(h.wallNow()+3600e3).toISOString()};
      const bad1=outcome(await A.submit(`${beginAs(ctxOf(h),'clearerA')}\n${clearCall(bad,k2)}`,h.deadline));
      must(!bad1.ok&&bad1.code==='evidence_invalid','invalid_evidence_not_refused');
      await finishTxn(h,A,ROLLBACK);
      must((await holdState(h,'clearerA',h2.id))[0]==='t'&&(await evidenceRows(h,'clearerA',h2.id)).length===0&&(await receiptRows(h,'clearerA',k2)).length===0,'failed_call_left_traces');
      const good=outcome(await B.submit(clearOpen(ctxOf(h),'clearerA',prep(h,h2,'r3'),k2),h.deadline));
      must(good.ok&&good.value?.replayed===false,'next_attempt_failed');
      await finishTxn(h,B,COMMIT);
      return {status:'PASS',code:'ok'};
    },
  },
  {
    name:'roleOrRuleChangeBeforeReplay',needs:{holds:['fault']},usesControl:true,
    // The supervised runner changes the CONFIGURED role/rule/membership between the first clear and its replay. Every replay must be refused.
    async run(h){
      const hold=h.takeHold('fault'),key=h.key('k1'),p=prep(h,hold,'c'),A=await h.open('a'),B=await h.open('b');
      const first=await openClear(h,A,'clearerA',p,key);must(first.ok&&first.value?.replayed===false,'first_clear_failed');
      await finishTxn(h,A,COMMIT);
      await assertPersisted(h,'clearerA',{hold,p,key,evidenceId:first.value.evidenceId});
      const other=ASSIGNABLE_ROLES.find(r=>r!==h.contract.fixture.rules.fault);
      const transitions=[
        [{action:'set-rule',kind:'fault',role:other},'wrong_role'],
        [{action:'remove-rule',kind:'fault'},'no_clearance_rule'],
        [{action:'set-membership-role',actor:'clearerA',role:other},'wrong_role'],
        [{action:'set-membership-active',actor:'clearerA',active:false},'hold_not_found'],
      ];
      try{
        for(const [change,expected] of transitions){
          await h.control.apply(validateControlAction(change));
          const replay=await openClear(h,B,'clearerA',p,key);
          must(!replay.ok&&replay.code===expected,'replay_not_refused_after_change');
          await finishTxn(h,B,ROLLBACK);
          must((await evidenceRows(h,'clearerA2',hold.id)).length===1,'refused_replay_wrote_something');      // evidence is readable by any member
          await h.control.apply({action:'restore',scope:'case'});
          must((await receiptRows(h,'clearerA',key)).length===1&&(await evidenceRows(h,'clearerA',hold.id)).length===1,'refused_replay_wrote_something');   // receipts are private to the owner
        }
      }finally{await h.control.apply({action:'restore',scope:'all'});}
      const back=await openClear(h,B,'clearerA',p,key);
      must(back.ok&&back.value?.replayed===true&&back.value.evidenceId===first.value.evidenceId,'replay_not_restored');
      await finishTxn(h,B,COMMIT);
      return {status:'PASS',code:'ok'};
    },
  },
  {
    name:'actorPrivateConflict',needs:{holds:['fault','fault']},
    // Someone else's key is invisible and is answered the same way as any other conflict; the owner's replay is unaffected.
    async run(h){
      const h1=h.takeHold('fault'),h2=h.takeHold('fault'),key=h.key('k1'),A=await h.open('a'),B=await h.open('b');
      const p1=prep(h,h1,'p1'),p2=prep(h,h2,'p2');
      const first=await openClear(h,A,'clearerA',p1,key);must(first.ok,'first_clear_failed');await finishTxn(h,A,COMMIT);
      await assertPersisted(h,'clearerA',{hold:h1,p:p1,key,evidenceId:first.value.evidenceId});
      const clash=await openClear(h,B,'clearerA2',p2,key);
      must(!clash.ok&&clash.code==='idempotency_conflict','foreign_key_reuse_not_a_conflict');
      await finishTxn(h,B,ROLLBACK);
      must((await holdState(h,'clearerA',h2.id))[0]==='t'&&(await evidenceRows(h,'clearerA',h2.id)).length===0,'conflict_cleared_something');
      must((await receiptRows(h,'clearerA',key)).length===1&&(await receiptRows(h,'clearerA2',key)).length===0,'receipt_not_private');
      const sameHold=await openClear(h,B,'clearerA2',p1,key);        // the foreign actor on the already-cleared hold learns nothing about the key
      must(!sameHold.ok&&sameHold.code==='hold_already_cleared','key_existence_leaked');
      await finishTxn(h,B,ROLLBACK);
      const mine=await openClear(h,A,'clearerA',p1,key);
      must(mine.ok&&mine.value?.replayed===true,'owner_replay_broken');
      await finishTxn(h,A,COMMIT);
      return {status:'PASS',code:'ok'};
    },
  },
  {
    name:'tenantDenial',needs:{holds:['fault']},
    // SV-036: the denial is only meaningful if there is something to deny. A clearer of the hold's OWN tenant clears it with evidence through the normal
    // authorized path, and that populated record (and its receipt) is confirmed in full. Only then does a user of the other organization try to clear
    // it, in their own tenant context and by naming the other tenant, and try to read it. An empty hold would prove nothing about isolation.
    async run(h){
      const hold=h.takeHold('fault'),setupKey=h.key('k0'),key=h.key('k1'),p=prep(h,hold,'t'),A=await h.open('a');
      const setup=await openClear(h,A,'clearerA',p,setupKey);
      must(setup.ok&&setup.value?.replayed===false&&setup.value.cleared===true,'tenant_setup_clear_failed');
      await finishTxn(h,A,COMMIT);
      must((await evidenceRows(h,'clearerA',hold.id)).length===1,'tenant_evidence_not_populated');
      await assertPersisted(h,'clearerA',{hold,p,key:setupKey,evidenceId:setup.value.evidenceId});
      const own=await openClear(h,A,'outsider',p,key,'b');
      must(!own.ok&&own.code==='hold_not_found','cross_tenant_clear_not_refused');
      await finishTxn(h,A,ROLLBACK);
      const named=await openClear(h,A,'outsider',p,key,'a');
      must(!named.ok&&named.code==='hold_not_found','named_tenant_clear_not_refused');
      await finishTxn(h,A,ROLLBACK);
      const st=await holdState(h,'clearerA',hold.id);
      must(st[0]==='f'&&st[2]===actorString(h.contract.fixture.actors.clearerA.userId),'tenant_denial_changed_the_hold');
      must((await receiptRows(h,'clearerA',key)).length===0,'tenant_denial_wrote_rows');
      await assertPersisted(h,'clearerA',{hold,p,key:setupKey,evidenceId:setup.value.evidenceId});      // unchanged by the denied attempts
      must((await h.read('outsider',q.evidenceDetail(hold.id))).rows.length===0,'other_tenant_can_read_evidence');
      must((await h.read('outsider',q.receiptDetail(setupKey))).rows.length===0,'other_tenant_can_read_receipt');
      must((await h.read('outsider',q.holdState(hold.id))).rows.length===0,'other_tenant_can_read_hold');
      return {status:'PASS',code:'ok'};
    },
  },
]);
export const REQUIRED_CASE_NAMES=Object.freeze(CASES.map(c=>c.name));
