// Clock-injected scheduler: local freshness ticks are independent of read success.
// One request at a time; transient failures back off to at most one retry per 30 seconds.
export function createEquipmentPolling({getSession,onTick=()=>{},canRead=()=>true,now=Date.now,intervalMs=5000,maxRetryMs=30000}){
 let current=null,nextRead=0,failures=0,pending=false;
 const retryable=error=>error&&(['network','timeout'].includes(error.code)||error.status===408||error.status===429||error.status>=500);
 return {async tick(){
  onTick(now());
  const session=getSession();
  if(session!==current){current=session;nextRead=now()+intervalMs;failures=0;}
  if(!session||pending||!canRead()||session.state.busy||session.state.phase==='loading'||now()<nextRead)return;
  if(session.state.phase!=='ready'&&!(session.state.phase==='error'&&retryable(session.state.error)))return;
  pending=true;
  try{await session.refresh({background:true});if(session===current){failures=0;nextRead=now()+intervalMs;}}
  catch{if(session===current){nextRead=now()+Math.min(maxRetryMs,intervalMs*2**Math.min(failures++,20));}}
  finally{pending=false;}
 }};
}
