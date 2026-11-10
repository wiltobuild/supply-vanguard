import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {change,ready,renderBoard} from './board-domain.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [command='list',...args]=process.argv.slice(2),flags={};let id;
for(let i=0;i<args.length;i++){if(args[i].startsWith('--')){const key=args[i].slice(2);flags[key]=args[i+1]&&!args[i+1].startsWith('--')?args[++i]:true;}else if(!id)id=args[i];else throw Error('Unexpected argument');}
function run(bin,args,{cwd=root,input,allowFailure=false}={}){const r=spawnSync(bin,args,{cwd,input,encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:4*1024*1024});if(r.error)throw r.error;if(r.status!==0&&!allowFailure)throw Error(`${bin} ${args[0]} failed: ${(r.stderr||r.stdout).trim()}`);return r;}
const git=(args,opts)=>run('git',args,opts);let scratch;
try{
 if(command==='help'){console.log('board list [--json] | init | claim ID --owner wil --agent wil-agent-1 | next --owner partner --agent partner-agent-1 | heartbeat ID --agent NAME | release ID --agent NAME | block ID --agent NAME --reason TEXT | submit ID --agent NAME --pr URL | complete ID --agent NAME | unblock ID --agent NAME --reason TEXT | rework ID --agent NAME --reason TEXT\nClaims last 120 minutes. Heartbeat every 30 minutes. Shared state is the remote task-board branch.');process.exit(0);}
 const remote=git(['remote','get-url','origin']).stdout.trim();if(!remote)throw Error('Set origin before using the shared board');
 scratch=mkdtempSync(join(tmpdir(),'supply-vanguard-board-'));git(['init','--bare',scratch]);
 const g=(args,opts={})=>git(args,{...opts,cwd:scratch});g(['remote','add','origin',remote]);
 const remoteSlug=remote.replace(/^https:\/\/github\.com\//,'').replace(/^git@github.com:/,'').replace(/\.git$/,'');
 const ref='refs/heads/task-board';
 function load(){const result=g(['ls-remote','--heads','origin',ref]).stdout.trim();if(!result)return null;g(['fetch','--quiet','origin',ref]);const head=g(['rev-parse','FETCH_HEAD']).stdout.trim(),board=JSON.parse(g(['show',`${head}:tasks.json`]).stdout);if(board.schemaVersion!==1||board.project!=='supply-vanguard')throw Error('Unexpected board schema');return {head,board};}
 function publish(board,parent){const blob=g(['hash-object','-w','--stdin'],{input:JSON.stringify(board,null,2)+'\n'}).stdout.trim(),md=g(['hash-object','-w','--stdin'],{input:renderBoard(board)}).stdout.trim();const tree=g(['mktree'],{input:`100644 blob ${md}\tREADME.md\n100644 blob ${blob}\ttasks.json\n`}).stdout.trim();const sha=g(['-c','user.name=Supply Vanguard Board','-c','user.email=board@supply-vanguard.local','commit-tree',tree,...(parent?['-p',parent]:[]),'-m',`${command}: ${id||'board'} (${flags.agent||'bootstrap'})`]).stdout.trim();return g(['push','--quiet','origin',`${sha}:${ref}`],{allowFailure:true});}
 const leaseId=randomUUID(),claimFile=()=>join(root,'.claims',`${id}.json`);
 for(let attempt=0;attempt<6;attempt++){
  const current=load();
  if(command==='list'){if(!current)throw Error('Board is not initialized. Run npm run board -- init');const b=current.board;if(flags.json)console.log(JSON.stringify(b,null,2));else{console.log('LIVE SHARED BOARD — '+remote+' / task-board');for(const t of b.tasks)console.log(`${t.id.padEnd(7)} ${t.status.padEnd(8)} ${(ready(t,b,Date.now())?'READY':'').padEnd(5)} ${t.title}${t.claim?' ['+t.claim.owner+'/'+t.claim.agent+' until '+t.claim.expiresAt+']':''}`);}break;}
  if(command==='init'){
   if(current){console.log('Shared board already exists; nothing changed.');break;}
   const b=JSON.parse(readFileSync(join(root,'planning/tasks.json'),'utf8'));b.tasks.find(t=>t.id==='SV-000').evidence=git(['rev-parse','HEAD']).stdout.trim();b.updatedAt=new Date().toISOString();const r=publish(b,null);if(r.status===0){console.log(`Created shared board: https://github.com/${remoteSlug}/tree/task-board`);break;}if(attempt===5)throw Error(r.stderr);continue;
  }
  if(!current)throw Error('Board not initialized');
  if(command==='next'){const candidate=current.board.tasks.find(t=>ready(t,current.board,Date.now()));if(!candidate)throw Error('No ready, unclaimed tasks');id=candidate.id;}
  if(!/^SV-\d{3}$/.test(id||''))throw Error('Use a task ID like SV-001');
  const task=current.board.tasks.find(t=>t.id===id);if(!task)throw Error('Unknown task');
  let claim;try{claim=JSON.parse(readFileSync(claimFile(),'utf8'));}catch{}
  let evidence;
  if(command==='submit'||command==='complete'){
   const url=command==='submit'?flags.pr:task.pr;if(!url||!url.startsWith(`https://github.com/${remoteSlug}/pull/`))throw Error('PR must belong to this repository');
   const p=JSON.parse(run('gh',['pr','view',url,'--json','state,mergedAt,mergeCommit']).stdout);
   if(command==='submit'&&p.state==='CLOSED')throw Error('Cannot submit a closed, unmerged PR');
   if(command==='complete'){if(!p.mergedAt)throw Error('PR must be merged before marking done');evidence={url,mergeCommit:p.mergeCommit?.oid,mergedAt:p.mergedAt};}
  }
  const next=change(current.board,{command:command==='next'?'claim':command,id,agent:flags.agent,owner:flags.owner,leaseId:['claim','next'].includes(command)?leaseId:claim?.leaseId,ttl:flags.minutes===undefined?120:Number(flags.minutes),pr:flags.pr,evidence,reason:flags.reason});
  const result=publish(next,current.head);
  if(result.status===0){
   if(['claim','next'].includes(command)){mkdirSync(join(root,'.claims'),{recursive:true});const tmp=claimFile()+'.tmp';writeFileSync(tmp,JSON.stringify({id,agent:flags.agent,leaseId},null,2));renameSync(tmp,claimFile());}
   console.log(JSON.stringify({task:next.tasks.find(t=>t.id===id),boardRevision:next.revision,nextStep:['claim','next'].includes(command)?`Create a work branch: git switch -c task/${id.toLowerCase()}-${String(flags.agent).replace(/[^a-zA-Z0-9-]/g,'-')}`:undefined},null,2));break;
  }
  if(attempt===5)throw Error(`Board update failed. No claim is confirmed. ${result.stderr}`);
  // Retry a competing fast-forward update against fresh shared state; never force-push.
 }
}catch(e){console.error(e.message);process.exitCode=1;}finally{if(scratch)rmSync(scratch,{recursive:true,force:true});}
