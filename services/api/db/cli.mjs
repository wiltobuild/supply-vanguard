// Usage: node services/api/db/cli.mjs <local-start|local-stop|migrate|rollback [n]|seed|reset>
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pgBin,startCluster,stopCluster,migrateUp,migrateDown,seed,applied,DEFAULT_PORT} from './lib.mjs';
const dataDir=process.env.SV_PGDATA||resolve(dirname(fileURLToPath(import.meta.url)),'.pgdata');
const url=process.env.DATABASE_URL||`postgresql://sv@127.0.0.1:${process.env.SV_PGPORT||DEFAULT_PORT}/postgres`;
const [cmd,arg]=process.argv.slice(2);
try{
 if(!pgBin())throw new Error('PostgreSQL 16+ not found. Install it (brew install postgresql@16) or set PG_BIN to its bin directory.');
 if(cmd==='local-start'){console.log('Local database ready at',startCluster(dataDir,Number(process.env.SV_PGPORT)||DEFAULT_PORT));}
 else if(cmd==='local-stop'){stopCluster(dataDir);console.log('Stopped');}
 else if(cmd==='migrate'){console.log('Applied:',migrateUp(url).join(', ')||'nothing to do');}
 else if(cmd==='rollback'){console.log('Rolled back:',migrateDown(url,Number(arg)||1).join(', ')||'nothing');}
 else if(cmd==='seed'){seed(url);console.log('Seeded synthetic data');}
 else if(cmd==='reset'){migrateDown(url,applied(url).length);migrateUp(url);seed(url);console.log('Reset and reseeded');}
 else if(cmd==='status'){console.log(applied(url).join('\n')||'no migrations applied');}
 else{console.log('Commands: local-start, local-stop, migrate, rollback [n], seed, reset, status');}
}catch(e){console.error(e.message);process.exitCode=1;}
