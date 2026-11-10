// SV-034: one owned psql session per handle. It never runs by itself: spawn, clock and nonce are INJECTED, and this module imports no
// process-spawning module. Tests drive it with a fake child process; the real `spawn` is supplied only by the opt-in path.
//
// Framing: every statement batch is followed by a `\echo SVEND <nonce> <seq> :ERROR :SQLSTATE :LAST_ERROR_MESSAGE` line, so rows, errors and
// completion all arrive in order on stdout. psql runs with ON_ERROR_STOP=0 so a raised exception does not kill the session; the error is
// reported through those variables. The nonce is random per session, so result data can never be mistaken for a sentinel.
import {BoundedText,buildPsqlInvocation,redact} from './contract.mjs';

export class TimeoutError extends Error {constructor(label){super('deadline_exceeded');this.name='TimeoutError';this.label=label;}}
export class SessionError extends Error {constructor(code){super(code);this.name='SessionError';this.code=code;}}
export const MAX_ROWS=200,MAX_CHARS=16384;

// A single deadline shared by everything in a run, supplied externally and measured on the injected clock.
export class Deadline {
  constructor(clock,atMs){this.clock=clock;this.atMs=atMs;}
  static after(clock,ms){return new Deadline(clock,clock.now()+ms);}
  remaining(){return Math.max(0,this.atMs-this.clock.now());}
  expired(){return this.remaining()===0;}
}
// Races a promise against the shared deadline using the injected timer. No sleeps, no unbounded waits.
export function withDeadline(promise,deadline,label){
  return new Promise((resolve,reject)=>{
    if(deadline.expired())return reject(new TimeoutError(label));
    const handle=deadline.clock.setTimer(()=>reject(new TimeoutError(label)),deadline.remaining());
    Promise.resolve(promise).then(v=>{deadline.clock.clearTimer(handle);resolve(v);},e=>{deadline.clock.clearTimer(handle);reject(e);});
  });
}

export function createPsqlSessionFactory({contract,spawn,clock,newNonce}){
  if(typeof spawn!=='function'||typeof newNonce!=='function'||!clock)throw new SessionError('collaborators_required');
  const owned=new Set();
  return {
    // Handles this factory opened and has not yet closed. The cleanup report is derived from this, never from a global process list.
    ownedHandles:()=>[...owned],
    async open(name,deadline){
      const inv=buildPsqlInvocation(contract,name);
      let child;
      try{child=spawn(inv.command,[...inv.args],{...inv.options,env:{...inv.env}});}catch{throw new SessionError('spawn_failed');}
      const nonce=newNonce(),errOut=new BoundedText(2048);
      let seq=0,buffer='',rows=[],rowChars=0,overflow=false,current=null,exited=false,tainted=false,tail=Promise.resolve();
      const finishCurrent=(result,error)=>{const c=current;current=null;if(!c)return;error?c.reject(error):c.resolve(result);};
      const onLine=line=>{
        if(line.startsWith(`SVEND ${nonce} `)){
          const parts=line.split(' ');
          if(Number(parts[2])!==current?.seq)return;                    // not the statement we are waiting for
          const failed=parts[3]==='true',sqlstate=parts[4]??'',message=parts.slice(5).join(' ');
          const result={rows,error:failed?{sqlstate,message:redact(message,contract)}:null,overflow};
          rows=[];rowChars=0;overflow=false;
          return finishCurrent(result);
        }
        if(!current)return;
        if(rows.length>=MAX_ROWS||rowChars+line.length>MAX_CHARS){overflow=true;return;}
        rows.push(line);rowChars+=line.length;
      };
      child.stdout.on('data',chunk=>{
        buffer+=String(chunk);
        if(buffer.length>MAX_CHARS*2){overflow=true;buffer=buffer.slice(-MAX_CHARS);}   // finite buffer even for a runaway line
        let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at).replace(/\r$/,'');buffer=buffer.slice(at+1);onLine(line);}
      });
      child.stderr.on('data',chunk=>errOut.push(chunk));
      child.on('error',()=>{exited=true;finishCurrent(null,new SessionError('session_error'));});
      child.on('exit',()=>{exited=true;finishCurrent(null,new SessionError('session_closed'));});
      const session={
        name,appName:inv.appName,pid:null,
        isOpen:()=>!exited,
        isTainted:()=>tainted,
        stderrSummary:()=>redact(errOut.toString(),contract),
        // Queued: statements on one session run strictly in order. The promise settles when THIS statement completes.
        submit(sql,deadline){
          const run=()=>withDeadline(new Promise((resolve,reject)=>{
            if(exited)return reject(new SessionError('session_closed'));
            current={seq:++seq,resolve,reject};
            try{child.stdin.write(`${sql}\n\\echo SVEND ${nonce} ${seq} :ERROR :SQLSTATE :LAST_ERROR_MESSAGE\n`);}
            catch{finishCurrent(null,new SessionError('write_failed'));}
          }),deadline,`${name}:submit`).catch(e=>{if(e instanceof TimeoutError)tainted=true;throw e;});
          const result=tail.then(run,run);tail=result.then(()=>{},()=>{});return result;
        },
        // Closes ONLY this handle: ask psql to quit, then terminate the owned child process. Never a PID lookup and never a server-side termination of a backend.
        async close(){
          const proof={name,graceful:false,terminated:false,uncertain:false};
          if(exited){owned.delete(session);proof.graceful=true;return proof;}
          const exitedPromise=new Promise(r=>{child.on('exit',()=>r(true));});
          try{child.stdin.write('\\q\n');child.stdin.end();}catch{/* handled below */}
          const waitExit=ms=>new Promise(r=>{const h=clock.setTimer(()=>r(false),ms);exitedPromise.then(v=>{clock.clearTimer(h);r(v);});});
          if(exited||await waitExit(2000)){proof.graceful=true;owned.delete(session);return proof;}
          try{child.kill('SIGTERM');proof.terminated=true;}catch{proof.uncertain=true;}
          if(await waitExit(2000)){owned.delete(session);return proof;}
          try{child.kill('SIGKILL');proof.terminated=true;}catch{proof.uncertain=true;}
          if(await waitExit(2000)){owned.delete(session);return proof;}
          proof.uncertain=true;return proof;
        },
      };
      owned.add(session);
      try{
        const first=await session.submit('SELECT pg_backend_pid();',deadline);
        const pid=Number(first.rows[0]);
        if(first.error||!Number.isInteger(pid))throw new SessionError('session_not_ready');
        session.pid=pid;
      }catch(e){await session.close();throw e instanceof TimeoutError||e instanceof SessionError?e:new SessionError('session_not_ready');}
      return session;
    },
  };
}
