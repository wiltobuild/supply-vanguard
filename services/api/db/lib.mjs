// Dependency-free helpers: run SQL through psql, manage a local or throwaway PostgreSQL cluster, apply migrations.
import {spawnSync} from 'node:child_process';
import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),migrationsDir=join(here,'migrations');
export const DEFAULT_PORT=54329;
export function pgBin(){
 for(const dir of [process.env.PG_BIN,...(process.env.PATH||'').split(':'),'/opt/homebrew/opt/postgresql@16/bin','/opt/homebrew/opt/postgresql@17/bin','/usr/local/opt/postgresql@16/bin','/usr/lib/postgresql/16/bin'])if(dir&&existsSync(join(dir,'initdb'))&&existsSync(join(dir,'psql')))return dir;
 return null;
}
// macOS needs a valid LC_ALL or the server dies with "postmaster became multithreaded".
const run=(bin,args,opts={})=>spawnSync(join(pgBin(),bin),args,{encoding:'utf8',timeout:120000,env:{...process.env,LC_ALL:process.env.LC_ALL||'en_US.UTF-8'},...opts});
export function psql(url,sql,{file}={}){
 const args=[url,'-X','-q','-v','ON_ERROR_STOP=1','-At',...(file?['-f',file]:['-c',sql])];
 const r=run('psql',args);if(r.status!==0)throw new Error((r.stderr||r.stdout||'psql failed').trim());return r.stdout.trim();
}
export function startCluster(dataDir,port=DEFAULT_PORT){
 if(!existsSync(join(dataDir,'PG_VERSION'))){const r=run('initdb',['-D',dataDir,'-U','sv','--auth=trust','-E','UTF8','--no-locale']);if(r.status!==0)throw new Error(r.stderr);}
 const r=run('pg_ctl',['-D',dataDir,'-o',`-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${dataDir}`,'-w','-l',join(dataDir,'server.log'),'start']);
 if(r.status!==0)throw new Error((r.stderr||r.stdout).trim());
 return `postgresql://sv@127.0.0.1:${port}/postgres`;
}
export function stopCluster(dataDir){run('pg_ctl',['-D',dataDir,'-m','fast','-w','stop']);}
export function createDatabase(adminUrl,name){if(!/^[a-z0-9_]+$/.test(name))throw new Error('Bad database name');psql(adminUrl,`CREATE DATABASE ${name}`);return adminUrl.replace(/\/[^/]*$/,`/${name}`);}
export function migrations(){
 const names=readdirSync(migrationsDir).filter(f=>/^\d{4}_[\w-]+\.up\.sql$/.test(f)).sort();
 return names.map(f=>({id:f.replace('.up.sql',''),up:join(migrationsDir,f),down:join(migrationsDir,f.replace('.up.sql','.down.sql'))}));
}
const ensureTable=url=>psql(url,'CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
export function applied(url){ensureTable(url);return psql(url,'SELECT id FROM schema_migrations ORDER BY id').split('\n').filter(Boolean);}
export function migrateUp(url){
 const done=new Set(applied(url)),ran=[];
 for(const m of migrations()){if(done.has(m.id))continue;
  // One transaction per migration: either the whole file and its record land, or neither.
  const wrapped=`BEGIN;\n${readFileSync(m.up,'utf8')}\nINSERT INTO schema_migrations (id) VALUES ('${m.id}');\nCOMMIT;`;
  psql(url,wrapped);ran.push(m.id);}
 return ran;
}
export function migrateDown(url,steps=1){
 const done=applied(url).reverse().slice(0,steps),byId=new Map(migrations().map(m=>[m.id,m])),ran=[];
 for(const id of done){const m=byId.get(id);if(!m||!existsSync(m.down))throw new Error(`No down migration for ${id}`);
  psql(url,`BEGIN;\n${readFileSync(m.down,'utf8')}\nDELETE FROM schema_migrations WHERE id = '${id}';\nCOMMIT;`);ran.push(id);}
 return ran;
}
// Owner-only bootstrap (SV-019). Forced row-level security (SV-005) applies even to the table owner, and no policy lets anyone
// create the first organization, so a plain seed fails for a non-superuser owner. Instead of weakening a policy or adding a
// runtime bypass, the owner switches FORCE off for the already-forced tables, loads the rows, and switches it back on, all in
// ONE transaction: if anything fails, nothing is loaded and FORCE is exactly as it was. A role that does not own the tables
// fails at the first ALTER ("must be owner"). Running again is a no-op because seed.sql skips an already-seeded database.
export const BOOTSTRAP_BEGIN=`BEGIN;
CREATE TEMP TABLE sv_forced ON COMMIT DROP AS
  SELECT c.oid::regclass AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT rel FROM sv_forced LOOP EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', r.rel); END LOOP;
END $$;
`;
export const BOOTSTRAP_END=`
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT rel FROM sv_forced LOOP EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', r.rel); END LOOP;
  IF EXISTS (SELECT 1 FROM sv_forced f JOIN pg_class c ON c.oid = f.rel::oid WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity)) THEN
    RAISE EXCEPTION 'row-level security was not restored';
  END IF;
END $$;
COMMIT;`;
export function bootstrap(url,sql){psql(url,BOOTSTRAP_BEGIN+sql+BOOTSTRAP_END);}
export function seed(url){bootstrap(url,readFileSync(join(here,'seed','seed.sql'),'utf8'));}
