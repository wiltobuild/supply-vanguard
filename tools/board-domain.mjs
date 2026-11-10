export function ready(task,board,now){return !['done','review','blocked'].includes(task.status)&&(!task.claim||Date.parse(task.claim.expiresAt)<=now)&&task.dependsOn.every(id=>board.tasks.find(t=>t.id===id)?.status==='done');}
export function change(board,{command,id,agent,owner,leaseId,now=Date.now(),ttl=120,pr,evidence,reason}){
 const next=structuredClone(board),task=next.tasks.find(t=>t.id===id);if(!task)throw Error(`Unknown task ${id}`);
 const at=new Date(now).toISOString();
 if(command==='claim'){
  if(!agent||!owner||!leaseId)throw Error('Claim requires agent, owner and lease ID');
  if(!Number.isFinite(ttl)||ttl<5||ttl>240)throw Error('Lease duration must be 5–240 minutes');
  if(!ready(task,next,now))throw Error('Task is claimed, not ready, or has unfinished dependencies');
  task.status='claimed';task.claim={agent,owner,leaseId,claimedAt:at,expiresAt:new Date(now+ttl*60000).toISOString()};
 }else if(command==='unblock'||command==='rework'){
  if(!agent||!reason)throw Error('Agent and reason required');
  if(command==='unblock'&&task.status!=='blocked')throw Error('Task is not blocked');
  if(command==='rework'&&task.status!=='review')throw Error('Only a submitted task can be returned for rework');
  task.status='ready';task.claim=null;task.blockedReason=null;task.reviewNote=reason;
 }else if(command==='complete'){
  if(task.status!=='review')throw Error('Only a submitted task can be completed');
  if(!agent)throw Error('Completion requires an agent');
  if(!evidence)throw Error('Merged PR evidence required');
  task.status='done';task.completedAt=at;task.completedBy=agent;task.evidence=evidence;task.claim=null;
 }else{
  if(task.status!=='claimed'||!task.claim||task.claim.agent!==agent||task.claim.leaseId!==leaseId||Date.parse(task.claim.expiresAt)<=now)throw Error('No valid matching claim; claim or renew before working');
  if(command==='heartbeat'){if(!Number.isFinite(ttl)||ttl<5||ttl>240)throw Error('Lease duration must be 5–240 minutes');task.claim.expiresAt=new Date(now+ttl*60000).toISOString();}
  else if(command==='release'){task.status='ready';task.claim=null;}
  else if(command==='block'){if(!reason)throw Error('Blocking reason required');task.status='blocked';task.blockedReason=reason;task.claim=null;}
  else if(command==='submit'){if(!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pr||''))throw Error('A GitHub pull request URL is required');task.status='review';task.pr=pr;task.submittedBy=agent;task.submittedAt=at;task.claim=null;}
  else throw Error('Unknown command');
 }
 next.revision++;next.updatedAt=at;next.history.push({at,taskId:id,command,agent,owner:owner||null});return next;
}
export function renderBoard(board){return `# Supply Vanguard shared task board\n\nRevision ${board.revision}. Live state is on the task-board branch. Use npm run board -- claim; do not edit this table manually.\n\n| Task | Status | Owner / agent | Lease expiry (UTC) | Dependencies | Work |\n|---|---|---|---|---|---|\n`+board.tasks.map(t=>`| ${t.id} ${t.title} | ${t.status} | ${t.claim?`${t.claim.owner} / ${t.claim.agent}`:'—'} | ${t.claim?.expiresAt||'—'} | ${t.dependsOn.join(', ')||'—'} | ${t.pr?`[PR](${t.pr})`:t.scope.join(', ')} |`).join('\n')+'\n';}
