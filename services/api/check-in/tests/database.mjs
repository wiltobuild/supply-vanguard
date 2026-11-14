import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';

export async function database() {
 if(process.env.CHECK_IN_BACKEND!=='native') {
  const db=new PGlite();let queue=Promise.resolve();
  return {native:false,exec:text=>db.exec(text),query:(...args)=>db.query(...args),async connect(){
   const before=queue;let release;queue=new Promise(r=>release=r);await before;
   await db.query('SET ROLE sv_check_in_runtime');return {query:(...a)=>db.query(...a),release};
  },async close(){await queue;await db.close();}};
 }
 const bin=process.env.CHECK_IN_PG_BIN || fileURLToPath(new URL('../node_modules/@embedded-postgres/windows-x64/native/bin/',import.meta.url));
 const dir=mkdtempSync(join(tmpdir(),'sv008-pg-'));
 const cleanup=()=>{const inside=relative(resolve(tmpdir()),resolve(dir));if(!inside.startsWith('sv008-pg-')||inside.includes('..')||isAbsolute(inside))throw Error('Unsafe test cluster cleanup target');rmSync(dir,{recursive:true,force:true});};
 const command=(name,args)=>{const r=spawnSync(join(bin,name+(process.platform==='win32'?'.exe':'')),args,{encoding:'utf8',windowsHide:true,timeout:30000});if(r.error||r.status!==0)throw Error(`${name}: ${r.error?.message||r.stderr||r.stdout}`);};
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 let started=false;
 try {
  command('initdb',['-D',dir,'-U','sv008_test_owner','--auth=trust','--encoding=UTF8','--no-locale']);
  command('pg_ctl',['-D',dir,'-l',join(dir,'server.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);started=true;
  const config={host:'127.0.0.1',port,user:'sv008_test_owner',database:'postgres'};
  const owner=new pg.Pool(config),runtime=new pg.Pool({...config,user:'sv_check_in_runtime',max:12});
  return {native:true,exec:text=>owner.query(text),query:(...args)=>owner.query(...args),connect:()=>runtime.connect(),
   async close(){await runtime.end();await owner.end();command('pg_ctl',['-D',dir,'-m','fast','-w','stop']);cleanup();}};
 } catch(error) {if(started)command('pg_ctl',['-D',dir,'-m','fast','-w','stop']);cleanup();throw error;}
}
export const sql=relative=>readFileSync(new URL(relative,import.meta.url),'utf8');
