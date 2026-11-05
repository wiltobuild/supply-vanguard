// Throwaway test harness, using the public auth/equipment modules unchanged.
// No token logs, persistence, issuance endpoint, or production identity provisioning.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createAuthorization} from '../../../services/api/auth/index.mjs';
import {createLocalIdentityProvider} from '../../../services/api/auth/local-identity.mjs';
import {createEquipmentHandler} from '../../../services/api/equipment/routes.mjs';
import {createWebHandler} from '../serve.mjs';
export async function startFixture(){
 const require=createRequire(new URL('../../../services/api/auth/package.json',import.meta.url));
 const {PGlite}=await import(pathToFileURL(require.resolve('@electric-sql/pglite')));
 const db=new PGlite(),sql=p=>readFileSync(new URL('../../../services/api/'+p,import.meta.url),'utf8');
 let available=Promise.resolve();
 async function connect(){const prior=available;let release;available=new Promise(r=>{release=r;});await prior;await db.query('SET ROLE sv_web_test_runtime');return {query:(...a)=>db.query(...a),release};}
 await db.exec(sql('db/migrations/0001_core.up.sql').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
 await db.exec(sql('auth/migrations/0001_auth.up.sql'));
 await db.exec(sql('db/seed/seed.sql'));
 const organizationId=(await db.query('SELECT id FROM organization')).rows[0].id;
 await db.exec(`CREATE ROLE sv_web_test_runtime NOSUPERUSER NOBYPASSRLS NOLOGIN;
 GRANT USAGE ON SCHEMA public TO sv_web_test_runtime;
 GRANT SELECT, INSERT, UPDATE ON organization,facility,ward,location,equipment_type,equipment,equipment_observation,equipment_event TO sv_web_test_runtime;
 GRANT SELECT ON auth_user,auth_membership TO sv_web_test_runtime;
 GRANT EXECUTE ON FUNCTION auth_resolve_identity(text,text) TO sv_web_test_runtime;`);
 const identityProvider=createLocalIdentityProvider({mode:'test'}),tokens={};
 for(const role of ['equipment_manager','viewer']){
  const {rows}=await db.query('INSERT INTO auth_user(issuer,subject) VALUES ($1,$2) RETURNING id',['urn:supply-vanguard:local','synthetic-web-'+role]);
  await db.query('INSERT INTO auth_membership(organization_id,user_id,role) VALUES ($1,$2,$3)',[organizationId,rows[0].id,role]);
  tokens[role]=identityProvider.issue('synthetic-web-'+role);
 }
 const api=createServer(createEquipmentHandler({authorization:createAuthorization({identityProvider,pool:{connect}})}));
 api.listen(0,'127.0.0.1');await once(api,'listening');
 const web=createServer(createWebHandler({apiOrigin:`http://127.0.0.1:${api.address().port}`}));
 web.listen(0,'127.0.0.1');await once(web,'listening');
 return {base:`http://127.0.0.1:${web.address().port}`,organizationId,tokens,
  revoke:()=>identityProvider.revoke(tokens.equipment_manager),
  async close(){await Promise.all([new Promise(r=>web.close(r)),new Promise(r=>api.close(r))]);await available;await db.close();}
 };
}
