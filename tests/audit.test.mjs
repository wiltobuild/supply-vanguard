// Included in the repository's required `npm test` command. The database-backed tests skip themselves when PGlite is not installed.
import '../services/api/audit/tests/audit.test.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseFilters,encodeCursor,decodeCursor,redactEvent,pseudonym,csvCell,toCsv,BadInput,MAX_LIMIT,REDACTED} from '../services/api/audit/rules.mjs';
const P=s=>new URLSearchParams(s);
test('filters: defaults, limits and rejection of unknown or malformed input',()=>{
 assert.deepEqual(parseFilters(P('')),{stream:'equipment',limit:25});
 assert.equal(parseFilters(P(`limit=${MAX_LIMIT}`)).limit,MAX_LIMIT);
 assert.equal(parseFilters(P('from=2026-11-05T10:00:00.123456Z')).from,'2026-11-05T10:00:00.123456Z');
 assert.equal(parseFilters(P('format=csv'),{forExport:true}).format,'csv');
 for(const bad of ['limit=0','limit=-1','limit=1.5','stream=x','kind=x','from=now','to=2026-11-05T10:00:00+01:00','nope=1','request=abc','from=2026-11-05T11:00:00Z&to=2026-11-05T10:00:00Z','actor='])assert.throws(()=>parseFilters(P(bad)),BadInput,bad);
 assert.throws(()=>parseFilters(P('limit=5'),{forExport:true}),BadInput);
 assert.throws(()=>parseFilters(P('format=csv')),BadInput);
});
test('cursors round-trip exact microseconds and reject anything else',()=>{
 const id='00000000-0000-4000-8000-000000000001',t='2026-11-05T10:00:00.123456Z';
 assert.deepEqual(decodeCursor(encodeCursor(t,id)),{t,id});
 for(const v of [{t:'2026-11-05T10:00:00.123Z',id},{t,id:'x'},{t:'2026-11-05T10:00:00.123456',id},{id}])assert.throws(()=>decodeCursor(Buffer.from(JSON.stringify(v)).toString('base64url')),BadInput);
 assert.throws(()=>decodeCursor('%%%'),BadInput);
});
test('redaction hides notes at any depth and pseudonymises the actor without mutating the original',()=>{
 const ev={id:'i',stream:'equipment',at:'t',kind:'admin',actor:'user:abc',source:'admin',equipmentId:'EQ-1',requestId:null,correlationId:'c',idempotencyKey:'k',before:{status:'a',note:'secret'},after:{items:[{Note:'x'},{n:1}],note:null},detail:null};
 const copy=structuredClone(ev),out=redactEvent(ev,'org-1');
 assert.deepEqual(ev,copy);
 assert.equal(out.before.note,REDACTED);assert.equal(out.after.items[0].Note,REDACTED);assert.equal(out.after.note,null,'an absent note stays null');assert.equal(out.before.status,'a');
 assert.equal(out.actor,pseudonym('user:abc','org-1'));assert.notEqual(out.actor,'user:abc');
 assert.equal('correlationId' in out,false);assert.equal('idempotencyKey' in out,false);
});
test('CSV cells are quoted and spreadsheet formulas are neutralised',()=>{
 assert.equal(csvCell('plain'),'"plain"');assert.equal(csvCell('a"b'),'"a""b"');assert.equal(csvCell(null),'""');assert.equal(csvCell(3),'"3"');
 for(const f of ['=1+1','+1','-1','@SUM(A1)','\tx','\rx'])assert.equal(csvCell(f),`"'${f}"`,JSON.stringify(f));
 const csv=toCsv([{at:'t',stream:'equipment',kind:'admin',actor:'user:1',source:'admin',equipmentId:'=X',requestId:null,before:{status:'a',version:0},after:{status:'b',version:1}}]);
 assert.equal(csv.split('\r\n').length,3);assert.ok(csv.includes(`"'=X"`));
});
