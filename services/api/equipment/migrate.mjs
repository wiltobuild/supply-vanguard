import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

const command=process.argv[2];
try{
 if(!['up','down'].includes(command))throw new Error('Usage: node services/api/equipment/migrate.mjs up|down');
 if(!process.env.DATABASE_URL)throw new Error('Set DATABASE_URL to the local maintenance database');
 const sql=readFileSync(new URL(`./migrations/0001_receipts.${command}.sql`,import.meta.url),'utf8');
 const executable=process.env.PG_BIN?join(process.env.PG_BIN,process.platform==='win32'?'psql.exe':'psql'):'psql';
 const result=spawnSync(executable,[process.env.DATABASE_URL,'-X','-q','-v','ON_ERROR_STOP=1'],{
  input:`BEGIN; SELECT pg_advisory_xact_lock(55023);\n${sql}\nCOMMIT;`,encoding:'utf8',windowsHide:true,timeout:120000
 });
 if(result.error)throw result.error;
 if(result.status!==0)throw new Error((result.stderr||result.stdout||'psql failed').trim());
 console.log(`Equipment receipt migration ${command} committed`);
}catch(error){console.error(error.message);process.exitCode=1;}
