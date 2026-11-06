import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Server} from 'node:http';
import {Readable} from 'node:stream';
import {createCheckInHost,CheckInHostError} from '../host.mjs';

// Explicit unit collaborators for startup/lifecycle errors only. Production host has no fixture imports.
// The API suite separately supplies actual SQL/auth fixtures through this same composite host.
function configuration({missing=false,unsafe=false,granted=true,queryFailure,beginFailure,rollbackFailure,releaseFailure}={}) {
 const queries=[],releases=[],verified=[];let connections=0;
 const client={async query(text,params){
  queries.push({text,params});
  if(text==='BEGIN READ ONLY'&&beginFailure)throw beginFailure;
  if(text==='ROLLBACK'&&rollbackFailure)throw rollbackFailure;
  if(text.includes('to_regclass')){if(queryFailure)throw queryFailure;return {rows:[{tables:missing?['check_in_receipt']:[],functions:[]}]};}
  if(text.includes(' AS unsafe'))return {rows:[{unsafe}]};
  if(text.includes('has_table_privilege'))return {rows:[{tables:granted,resolver:true}]};
  return {rows:[]};
 },release(error){releases.push(error);if(releaseFailure)throw Error('synthetic release failure');}};
 const pool={async connect(){connections++;return client;},end(){assert.fail('Caller owns the pool; the host must not end it');}};
 const identityProvider={async verify(request){verified.push(request);return null;}};
 return {pool,identityProvider,client,queries,releases,verified,get connections(){return connections;}};
}
const code=expected=>error=>error instanceof CheckInHostError&&error.code===expected;
async function request(host,url,{method='GET',headers={},chunks=[]}={}) {
 const req=Readable.from(chunks);Object.assign(req,{url,method,headers,socket:{remoteAddress:'127.0.0.1'}});
 let status,responseHeaders,body;const res={writeHead(s,h){status=s;responseHeaders=h;},end(data){body=JSON.parse(data);}};
 await host.handle(req,res);return {status,headers:responseHeaders,body,req};
}
function simulatedServer(t,{listenError=false,closeError=false}={}) {
 const calls={listen:[],close:0};let server;
 t.mock.method(Server.prototype,'listen',function(options){server=this;calls.listen.push(options);queueMicrotask(()=>this.emit(listenError?'error':'listening',...(listenError?[Error('synthetic bind failure')]:[])));return this;});
 t.mock.method(Server.prototype,'close',function(callback){calls.close++;queueMicrotask(()=>callback(closeError?Error('synthetic close failure'):undefined));return this;});
 return {calls,get server(){return server;}};
}
test('host requires an explicit pool/verifier and does not load config or create fallback identities',()=>{
 for(const value of [undefined,null,[],{},'config.mjs',{pool:{connect(){}}},{identityProvider:{verify(){}}},{pool:{connect:3},identityProvider:{verify(){}}}])assert.throws(()=>createCheckInHost(value),code('invalid_configuration'));
});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
for(const outcome of ['late denial','verifier failure','cancelled request'])test(`close drains admitted verifier work through ${outcome}`,async()=>{
 const c=configuration(),entered=deferred(),verification=deferred();let verifierActive=false,verifierCalls=0;
 c.identityProvider.verify=async req=>{verifierCalls++;verifierActive=true;entered.resolve(req);try{return await verification.promise;}finally{verifierActive=false;}};
 const host=createCheckInHost(c);await host.ready();
 const handling=request(host,'/organizations/00000000-0000-4000-8000-000000000001/equipment');const req=await entered.promise;
 if(outcome==='cancelled request')req.destroy();
 let closed=false;const closing=host.close();closing.then(()=>closed=true);assert.equal(host.close(),closing);
 try{
  await flush();assert.equal(closed,false,'close must wait for the admitted verifier');assert.equal(verifierActive,true);
  const rejected=await request(host,'/organizations/00000000-0000-4000-8000-000000000001/equipment');assert.equal(rejected.status,503);assert.equal(verifierCalls,1);
 }finally{if(outcome==='late denial')verification.resolve(null);else verification.reject(Error('synthetic verifier interruption'));await handling;await closing;}
 assert.equal((await handling).status,outcome==='late denial'?401:500);assert.equal(verifierActive,false);assert.equal(host.state,'closed');assert.equal(c.connections,1,'denied verification never leased a runtime connection');
});
for(const failed of [false,true])test(`close drains active ${failed?'failed transaction rollback':'transaction commit'} and lease release`,async()=>{
 const c=configuration(),queryEntered=deferred(),queryResume=deferred(),cleanupEntered=deferred(),cleanupResume=deferred();
 const user='00000000-0000-4000-8000-000000000901',queries=[];let leased=false,transaction=false,released=0;
 c.identityProvider.verify=async()=>({issuer:'urn:synthetic:host',subject:'fictional-operator'});
 const host=createCheckInHost(c);await host.ready();
 c.pool.connect=async()=>{leased=true;return {async query(text){
  queries.push(text);
  if(text==='BEGIN'){transaction=true;return {rows:[]};}
  if(text==='COMMIT'||text==='ROLLBACK'){cleanupEntered.resolve();await cleanupResume.promise;transaction=false;return {rows:[]};}
  if(text.includes(' AS unsafe'))return {rows:[{unsafe:false}]};
  if(text.includes('auth_resolve_identity'))return {rows:[{id:user}]};
  if(text.includes('SELECT role'))return {rows:[{role:'operator'}]};
  if(text.includes('FROM equipment e')){queryEntered.resolve();await queryResume.promise;if(failed)throw Error('synthetic request SQL failure');return {rows:[]};}
  return {rows:[]};
 },release(){leased=false;released++;}};};
 const handling=request(host,'/organizations/00000000-0000-4000-8000-000000000001/equipment');await queryEntered.promise;
 let closed=false;const closing=host.close();closing.then(()=>closed=true);
 try{
  await flush();assert.equal(closed,false,'active query work must drain');assert.equal(leased,true);assert.equal(transaction,true);
  queryResume.resolve();await cleanupEntered.promise;await flush();assert.equal(closed,false,'COMMIT/ROLLBACK and release must finish before close');assert.equal(leased,true);assert.equal(transaction,true);
 }finally{queryResume.resolve();cleanupResume.resolve();await handling;await closing;}
 const response=await handling;assert.equal(response.status,failed?500:200);assert.equal(released,1);assert.equal(leased,false);assert.equal(transaction,false);assert.ok(queries.includes(failed?'ROLLBACK':'COMMIT'));assert.equal(host.state,'closed');
});
test('rejected BEGIN acknowledgement rolls back and discards the uncertain client',async()=>{
 const beginFailure=Error('synthetic ambiguous BEGIN acknowledgement'),c=configuration({beginFailure}),host=createCheckInHost(c);
 try{await assert.rejects(host.ready(),code('provisioning_unavailable'));assert.deepEqual(c.queries.map(q=>q.text),['BEGIN READ ONLY','ROLLBACK']);assert.equal(c.releases.length,1);assert.equal(c.releases[0],beginFailure);}finally{await host.close();}
});
test('rejected BEGIN and failed rollback discard with the cleanup error while retaining safe mapping',async()=>{
 const beginFailure=Error('private BEGIN detail'),rollbackFailure=Error('private rollback detail'),c=configuration({beginFailure,rollbackFailure}),host=createCheckInHost(c);
 try{
  await assert.rejects(host.ready(),code('provisioning_unavailable'));assert.deepEqual(c.queries.map(q=>q.text),['BEGIN READ ONLY','ROLLBACK']);assert.equal(c.releases[0],rollbackFailure);
  const response=await request(host,'/organizations/a/check-ins',{method:'POST'});assert.equal(response.status,503);assert.doesNotMatch(JSON.stringify(response.body),/private BEGIN|private rollback/);
 }finally{await host.close();}
});
test('release failure after rejected BEGIN remains visible and still receives a discard error',async()=>{
 const beginFailure=Error('synthetic ambiguous BEGIN'),c=configuration({beginFailure,releaseFailure:true}),host=createCheckInHost(c);
 try{await assert.rejects(host.ready(),code('connection_release_failed'));assert.equal(c.releases.length,1);assert.equal(c.releases[0],beginFailure);}finally{await host.close();}
});
test('failed listener close still drains admitted work and preserves the repeated rejection',async t=>{
 const socket=simulatedServer(t,{closeError:true}),c=configuration(),entered=deferred(),verification=deferred();
 c.identityProvider.verify=async()=>{entered.resolve();return verification.promise;};
 const host=createCheckInHost(c);await host.listen();const handling=request(host,'/organizations/a/equipment');await entered.promise;
 let settled=false;const closing=host.close(),observed=closing.then(()=>{settled=true;return null;},error=>{settled=true;return error;});
 try{await flush();assert.equal(socket.calls.close,1);assert.equal(settled,false,'listener failure must not abandon admitted request work');assert.equal(host.close(),closing);}
 finally{verification.resolve(null);await handling;await observed;}
 assert.equal((await observed).code,'close_failed');assert.equal(host.state,'close_failed');assert.equal(host.lastError.code,'close_failed');assert.equal(socket.calls.close,1);assert.equal(host.close(),closing);
});
test('startup verification is cached, read-only and releases its supplied connection',async()=>{
 const c=configuration(),host=createCheckInHost(c);await Promise.all([host.ready(),host.ready()]);assert.equal(c.connections,1);assert.equal(c.releases.length,1);
 assert.equal(c.queries[0].text,'BEGIN READ ONLY');assert.equal(c.queries.at(-1).text,'COMMIT');
 for(const query of c.queries)assert.match(query.text,/^(?:BEGIN READ ONLY$|SELECT\s|COMMIT$|ROLLBACK$)/);
 assert.equal(c.verified.length,0);await host.close();assert.equal(host.state,'closed');
});
test('missing schema, unsafe role and missing grants fail clearly before any bind',async t=>{
 const socket=simulatedServer(t);
 for(const [options,expected]of [[{missing:true},'missing_schema'],[{unsafe:true},'unsafe_runtime_role'],[{granted:false},'missing_runtime_grants']]){
  const c=configuration(options),host=createCheckInHost(c);await assert.rejects(host.listen(),code(expected));assert.equal(c.queries.at(-1).text,'ROLLBACK');assert.equal(c.releases.length,1);await host.close();
 }
 assert.equal(socket.calls.listen.length,0);
});
test('database and cleanup failures do not leak their details, and uncertain cleanup discards the client',async()=>{
 const rollbackFailure=Error('synthetic rollback failure'),c=configuration({queryFailure:Error('private connection details'),rollbackFailure}),host=createCheckInHost(c);
 await assert.rejects(host.ready(),code('provisioning_unavailable'));assert.equal(c.releases[0],rollbackFailure);
 const response=await request(host,'/organizations/fictional/check-ins',{method:'POST'});assert.equal(response.status,503);assert.equal(response.body.error,'host_not_ready');assert.doesNotMatch(JSON.stringify(response.body),/private connection|rollback failure/);await host.close();
 const release=configuration({releaseFailure:true}),other=createCheckInHost(release);await assert.rejects(other.ready(),code('connection_release_failed'));await other.close();
});
test('invalid leased clients fail clearly and release any supplied releaser',async()=>{
 let released=0;const host=createCheckInHost({pool:{async connect(){return {release(){released++;}};}},identityProvider:{verify(){}}});
 await assert.rejects(host.ready(),code('invalid_pool'));assert.equal(released,1);await host.close();
});
test('route boundaries reject unrelated, absolute and normalized traversal paths without reading a body or database',async()=>{
 const c=configuration(),host=createCheckInHost(c);
 for(const url of ['/','/organizations/a/check-ins/extra','/organizations/a/check-ins/locations/','/organizations/a/equipment/EQ-001/extra','/organizations/a/equipment/EQ-001/observations/extra']){
  const response=await request(host,url,{method:'POST',chunks:[Buffer.from('untrusted body')]});assert.equal(response.status,404);assert.equal(response.req.readableDidRead,false);
 }
 for(const url of ['http://example.test/organizations/a/check-ins','//example.test/organizations/a/check-ins','/organizations/a/check-ins/../equipment','/organizations/a/check-ins#fragment'])assert.equal((await request(host,url)).status,400);
 assert.equal(c.connections,0);await host.close();
});
test('both exact route families use the supplied verifier and preserve original request/header/body references',async()=>{
 const c=configuration(),host=createCheckInHost(c);
 for(const [url,method]of [['/organizations/a/equipment?limit=1','GET'],['/organizations/a/equipment/EQ-001','PATCH'],['/organizations/a/equipment/EQ-001/observations','POST'],['/organizations/a/check-ins','POST'],['/organizations/a/check-ins/locations','GET']]){
  const headers={authorization:'Bearer synthetic-test-only','content-type':'application/json','idempotency-key':'preserved'},response=await request(host,url,{method,headers,chunks:[Buffer.from('{bad')]});
  assert.equal(response.status,401);assert.equal(c.verified.at(-1),response.req);assert.equal(response.req.headers,headers);assert.equal(response.req.readableDidRead,false);assert.equal(response.headers['Cache-Control'],'no-store');
 }
 assert.equal(c.connections,1,'only the cached read-only readiness check opens a connection for rejected identities');await host.close();
});
test('listen fixes the interface to 127.0.0.1 and close is idempotent without closing caller resources',async t=>{
 const socket=simulatedServer(t),c=configuration(),host=createCheckInHost(c);
 for(const options of [null,[],{host:'0.0.0.0'},{port:0},{port:1.5},{port:65536},{port:'4181'}])await assert.rejects(host.listen(options));
 assert.equal(socket.calls.listen.length,0);assert.equal(c.connections,0);
 assert.deepEqual(await host.listen({port:4181}),{host:'127.0.0.1',port:4181});assert.deepEqual(socket.calls.listen,[{host:'127.0.0.1',port:4181}]);assert.equal(host.state,'listening');
 await assert.rejects(host.listen(),code('invalid_lifecycle'));
 const closing=host.close();assert.equal(host.close(),closing);await closing;assert.equal(socket.calls.close,1);assert.equal(host.state,'closed');await assert.rejects(host.ready(),code('host_closed'));
 assert.equal((await request(host,'/organizations/a/equipment')).status,503);
});
test('bind errors reject startup with safe details and leave close usable',async t=>{
 const socket=simulatedServer(t,{listenError:true}),host=createCheckInHost(configuration());
 await assert.rejects(host.listen(),code('listen_failed'));await host.close();assert.equal(host.state,'closed');assert.equal(socket.calls.close,0);
});
test('failed server shutdown is reported as unconfirmed and is not silently retried',async t=>{
 const socket=simulatedServer(t,{closeError:true}),host=createCheckInHost(configuration());await host.listen();
 const closing=host.close();await assert.rejects(closing,code('close_failed'));assert.equal(host.state,'close_failed');assert.equal(host.lastError.code,'close_failed');assert.equal(host.close(),closing);assert.equal(socket.calls.close,1);
});
test('closing during readiness prevents a later bind and releases the pending connection',async t=>{
 const socket=simulatedServer(t),c=configuration();let connected;
 const host=createCheckInHost({pool:{connect:()=>new Promise(resolve=>connected=resolve)},identityProvider:c.identityProvider});
 const starting=host.listen(),closing=host.close();connected(c.client);await assert.rejects(starting,code('host_closed'));await closing;assert.equal(socket.calls.listen.length,0);assert.equal(c.releases.length,1);assert.equal(host.state,'closed');
});
test('a server error after startup closes admission and remains visible to the caller',async t=>{
 const socket=simulatedServer(t),host=createCheckInHost(configuration());await host.listen();socket.server.emit('error',Error('synthetic runtime error'));
 assert.equal(host.state,'failed');assert.equal(host.lastError.code,'server_failed');assert.equal((await request(host,'/organizations/a/equipment')).status,503);await host.close();assert.equal(host.state,'closed');
});
test('close waits for a standalone readiness check to release its leased connection',async()=>{
 const c=configuration();let connected,closed=false;
 const host=createCheckInHost({pool:{connect:()=>new Promise(resolve=>connected=resolve)},identityProvider:c.identityProvider});
 const preparing=host.ready(),closing=host.close();closing.then(()=>closed=true);await Promise.resolve();assert.equal(closed,false);assert.equal(c.releases.length,0);
 connected(c.client);await preparing;await closing;assert.equal(c.releases.length,1);assert.equal(host.state,'closed');
});
