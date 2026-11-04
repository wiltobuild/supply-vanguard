import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
test('two independent agent checkouts cannot both claim the same remote task',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vanguard-race-'));const repo=resolve(import.meta.dirname,'..');
 const git=(args,cwd=dir)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 const cli=(cwd,args)=>new Promise(resolve=>{const p=spawn(process.execPath,['tools/board.mjs',...args],{cwd,windowsHide:true});let output='';p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);p.on('error',e=>resolve({code:1,output:e.message}));p.on('close',code=>resolve({code,output}));});
 try{
  const remote=join(dir,'remote.git');git(['init','--bare',remote]);const clones=[];
  for(const name of ['a','b']){const cwd=join(dir,name);mkdirSync(cwd);git(['init'],cwd);git(['config','user.name','Test'],cwd);git(['config','user.email','test@example.com'],cwd);git(['remote','add','origin',remote],cwd);cpSync(join(repo,'tools'),join(cwd,'tools'),{recursive:true});mkdirSync(join(cwd,'planning'));cpSync(join(repo,'planning/tasks.json'),join(cwd,'planning/tasks.json'));writeFileSync(join(cwd,'README.md'),'fixture');git(['add','.'],cwd);git(['commit','-m','fixture'],cwd);clones.push(cwd);}
  const init=await cli(clones[0],['init']);assert.equal(init.code,0,init.output);const heads=clones.map(c=>git(['rev-parse','HEAD'],c));
  const results=await Promise.all(clones.map((c,i)=>cli(c,['claim','SV-001','--owner',String(i),'--agent','agent-'+i])));
  assert.deepEqual(results.map(r=>r.code).sort(),[0,1],JSON.stringify(results));
  const b=JSON.parse(git(['show','task-board:tasks.json'],remote));assert.equal(b.revision,1);assert.equal(b.tasks.find(t=>t.id==='SV-001').status,'claimed');
  clones.forEach((c,i)=>assert.equal(git(['rev-parse','HEAD'],c),heads[i]));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
