// SV-034: the orchestrator. Every collaborator is INJECTED (session factory, fixture control, clock), so nothing here connects by itself.
// Guarantees:
//   - preflight must pass before any case runs; a failed or incomplete preflight leaves every case NOT RUN;
//   - each case gets fresh owned sessions and ALWAYS cleans them up (roll back, then close only those handles), pass or fail;
//   - one shared external deadline bounds everything; a timeout, a dead session, a failed cleanup or an exception is UNCERTAIN, never a pass;
//   - the receipt can claim acceptance only if every required case passed, cleanup is certain and nothing was skipped.
import {Deadline,withDeadline,TimeoutError,SessionError} from './session.mjs';
import {ContractError,OPT_IN_SCOPE,redact} from './contract.mjs';
import {SqlBuildError,beginAs,q} from './sql.mjs';
import {runPreflight} from './preflight.mjs';
import {CASES,CaseFail,validateControlAction,REQUIRED_CASE_NAMES} from './cases.mjs';

export const STATUS=Object.freeze({PASS:'PASS',FAIL:'FAIL',NOT_RUN:'NOT RUN',UNCERTAIN:'UNCERTAIN'});

// Groups the supplied fixture so each case takes DISTINCT items: plain holds (no request on their equipment), stacked pairs and singles
// (equipment that has a request to claim for).
function planPool(contract){
  const f=contract.fixture,withRequest=new Set(f.requests.map(r=>r.equipmentId));
  const byEquipment=new Map();
  for(const h of f.holds){if(!byEquipment.has(h.equipmentId))byEquipment.set(h.equipmentId,[]);byEquipment.get(h.equipmentId).push(h);}
  const pool={plain:[],pairs:[],singles:[],requestFor:new Map(f.requests.map(r=>[r.equipmentId,r]))};
  for(const [eq,list] of byEquipment){
    if(!withRequest.has(eq))pool.plain.push(...list);
    else if(list.length===2)pool.pairs.push({eq,holds:list,used:false});
    else if(list.length===1)pool.singles.push({eq,hold:list[0],used:false});
  }
  pool.plain=pool.plain.map(h=>({...h,used:false}));
  return pool;
}
// Can the pool satisfy a case's needs? (Checked before the case starts, so a shortage is NOT RUN, not a half-run case.)
function canSupply(pool,needs={}){
  const used=new Set();
  for(const kind of needs.holds??[]){const hit=pool.plain.find(h=>!h.used&&!used.has(h.id)&&h.kind===kind);if(!hit)return false;used.add(hit.id);}
  if(needs.stackedPair){const [a,b]=needs.stackedPair;if(!pool.pairs.some(p=>!p.used&&p.holds.some(h=>h.kind===a)&&p.holds.some(h=>h.kind===b)))return false;}
  if(needs.single&&!pool.singles.some(s=>!s.used))return false;
  return true;
}

export async function runAcceptance({contract,factory,control,clock,wall=()=>Date.now(),cases=CASES,deadlineMs,preflight=runPreflight}){
  const deadline=Deadline.after(clock,deadlineMs??contract.runtime.deadlineMs);
  const receipt={schemaVersion:1,scope:OPT_IN_SCOPE,runMarker:contract.runMarker,status:'INCOMPLETE',accepted:false,preflight:null,cases:[],cleanup:{certain:true,sessions:[]}};
  const notRun=code=>cases.map(c=>({name:c.name,status:STATUS.NOT_RUN,code}));
  const finish=()=>{
    const names=new Set(receipt.cases.filter(c=>c.status===STATUS.PASS).map(c=>c.name));
    const allRequiredPassed=REQUIRED_CASE_NAMES.every(n=>names.has(n));
    const anyFail=receipt.cases.some(c=>c.status===STATUS.FAIL)||(receipt.preflight&&!receipt.preflight.passed);
    receipt.accepted=Boolean(receipt.preflight?.passed)&&allRequiredPassed&&receipt.cleanup.certain&&receipt.cases.every(c=>c.status===STATUS.PASS);
    receipt.status=receipt.accepted?'PASS':anyFail?'FAIL':'INCOMPLETE';
    return receipt;
  };

  let verifier;
  try{verifier=await factory.open('v',deadline);}
  catch(e){receipt.preflight={passed:false,checks:[{id:'connect',ok:false,code:e instanceof TimeoutError?'deadline_exceeded':'cannot_connect'}]};receipt.cases=notRun('preflight_failed');return finish();}
  const sleep=ms=>new Promise(r=>clock.setTimer(r,ms));
  const read1=async sql=>verifier.submit(sql,deadline);
  try{
    try{receipt.preflight=await preflight({contract,query:read1});}
    catch(e){receipt.preflight={passed:false,checks:[{id:'preflight',ok:false,code:e instanceof TimeoutError?'deadline_exceeded':'preflight_error'}]};}
    if(!receipt.preflight.passed){receipt.cases=notRun('preflight_failed');return finish();}

    const pool=planPool(contract);
    for(const [index,def] of cases.entries()){
      if(deadline.expired()){receipt.cases.push({name:def.name,status:STATUS.NOT_RUN,code:'deadline_exceeded'});continue;}
      if(def.usesControl&&!control){receipt.cases.push({name:def.name,status:STATUS.NOT_RUN,code:'fixture_control_unavailable'});continue;}
      if(!canSupply(pool,def.needs)){receipt.cases.push({name:def.name,status:STATUS.NOT_RUN,code:'fixture_incomplete'});continue;}
      const owned=[],tag=`c${index}`;
      let controlUsed=false;
      const h={
        contract,deadline,marker:contract.runMarker,
        wallNow:wall,observedAt:()=>new Date(wall()-60000).toISOString(),
        key:label=>`${contract.runMarker}-${def.name.slice(0,16)}-${label}`,
        control:{apply:async action=>{
          validateControlAction(action);controlUsed=true;
          const res=await withDeadline(control.apply(action),deadline,'control');
          if(!res||res.ok!==true)throw new CaseFail('fixture_control_failed');
          return res;
        }},
        open:async name=>{const s=await factory.open(`${tag}${name}`,deadline);owned.push(s);return s;},
        // A scoped read as an actor on the shared verifier. The ROLLBACK is its own statement (psql reports only the last statement's status).
        read:async(actor,sql)=>{const r=await verifier.submit(`${beginAs(contract,actor)}\n${sql}`,deadline);await verifier.submit('ROLLBACK;',deadline);return r;},
        // Deterministic wait: the session is OBSERVED waiting on the advisory lock before the holder is released. Bounded by the shared deadline.
        waitQueued:async session=>{
          for(let i=0;i<2000;i++){
            const r=await verifier.submit(q.lockWaiters(session.appName),deadline);
            if(!r.error&&Number(r.rows[0])>=1)return;
            await withDeadline(sleep(25),deadline,'wait');
          }
          throw new TimeoutError('wait');
        },
        takeHold:kind=>{const hit=pool.plain.find(x=>!x.used&&x.kind===kind);if(!hit)throw new CaseFail('fixture_incomplete');hit.used=true;return hit;},
        takeStackedPair:(kindA,kindB)=>{
          const p=pool.pairs.find(x=>!x.used&&x.holds.some(y=>y.kind===kindA)&&x.holds.some(y=>y.kind===kindB));if(!p)throw new CaseFail('fixture_incomplete');
          p.used=true;return {first:p.holds.find(y=>y.kind===kindA),second:p.holds.find(y=>y.kind===kindB&&y.kind!==kindA)??p.holds.find(y=>y.kind===kindB),request:pool.requestFor.get(p.eq)};
        },
        takeSingle:()=>{const s=pool.singles.find(x=>!x.used);if(!s)throw new CaseFail('fixture_incomplete');s.used=true;return {hold:s.hold,request:pool.requestFor.get(s.eq)};},
      };
      const entry={name:def.name,status:STATUS.UNCERTAIN,code:'not_finished'};
      const started=clock.now();
      try{
        const verdict=await withDeadline(def.run(h),deadline,def.name);
        entry.status=verdict?.status===STATUS.PASS?STATUS.PASS:STATUS.FAIL;entry.code=verdict?.code??'unexpected_verdict';
      }catch(e){
        if(e instanceof CaseFail){entry.status=e.code==='fixture_incomplete'?STATUS.NOT_RUN:STATUS.FAIL;entry.code=e.code;}
        else if(e instanceof TimeoutError){entry.status=STATUS.UNCERTAIN;entry.code='deadline_exceeded';}
        else if(e instanceof SessionError){entry.status=STATUS.UNCERTAIN;entry.code=`session_${e.code}`;}
        else if(e instanceof ContractError||e instanceof SqlBuildError){entry.status=STATUS.UNCERTAIN;entry.code=`harness_${e.code}`;}
        else{entry.status=STATUS.UNCERTAIN;entry.code='harness_error';}
      }finally{
        // Unconditional cleanup of what THIS case owns: finish any open transaction, release its locks (they end with the transaction),
        // close only these handles, then ask the runner to restore any fixture it changed. Any doubt makes the case UNCERTAIN.
        let certain=true;
        for(const s of owned){
          try{if(s.isOpen()&&!s.isTainted())await s.submit('ROLLBACK;',deadline);}catch{certain=false;}
          try{const proof=await s.close();receipt.cleanup.sessions.push({name:s.name,graceful:proof.graceful,terminated:proof.terminated,uncertain:proof.uncertain});if(proof.uncertain)certain=false;}
          catch{certain=false;receipt.cleanup.sessions.push({name:s.name,graceful:false,terminated:false,uncertain:true});}
        }
        if(controlUsed){try{const r=await withDeadline(control.apply({action:'restore',scope:'all'}),deadline,'control');if(!r||r.ok!==true)certain=false;}catch{certain=false;}}
        if(!certain){receipt.cleanup.certain=false;if(entry.status===STATUS.PASS){entry.status=STATUS.UNCERTAIN;entry.code='cleanup_uncertain';}}
        entry.durationMs=Math.max(0,clock.now()-started);
        receipt.cases.push(entry);
      }
    }
  }finally{
    try{const proof=await verifier.close();receipt.cleanup.sessions.push({name:verifier.name,graceful:proof.graceful,terminated:proof.terminated,uncertain:proof.uncertain});if(proof.uncertain)receipt.cleanup.certain=false;}
    catch{receipt.cleanup.certain=false;}
    if(factory.ownedHandles().length>0)receipt.cleanup.certain=false;     // anything this run opened and did not close is reported, never ignored
  }
  return finish();
}
// Receipts carry codes and counts only. This is the last line of defence against a value leaking into a log.
export const redactedReceipt=(receipt,contract)=>JSON.parse(redact(JSON.stringify(receipt),contract,100000));
