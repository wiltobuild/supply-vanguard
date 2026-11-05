// Included in the repository's required `npm test` command. The database-backed tests skip themselves when their
// dependency (PGlite, or native PostgreSQL) is not installed.
import '../services/api/requests/tests/requests.test.mjs';
import '../services/api/requests/tests/claim-race.native.test.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateRequestInput,validateClaimInput,summarize,CLAIM_ERRORS,MAX_ITEMS} from '../packages/domain/requests/index.js';
test('request input is validated',()=>{
 assert.deepEqual(validateRequestInput({items:[{equipmentType:'monitor'}]}),{note:undefined,items:[{equipmentType:'monitor'}]});
 for(const bad of [null,[],{},{items:[]},{items:[{}]},{items:[{equipmentType:''}]},{items:[{equipmentType:'m',x:1}]},{items:[{equipmentType:'m'}],note:5},{items:[{equipmentType:'m'}],extra:1},{items:Array.from({length:MAX_ITEMS+1},()=>({equipmentType:'m'}))}])assert.throws(()=>validateRequestInput(bad),undefined,JSON.stringify(bad)?.slice(0,50));
 assert.deepEqual(validateClaimInput({equipmentId:'EQ-1',expectedVersion:0}),{equipmentId:'EQ-1',expectedVersion:0});
 for(const bad of [{},{equipmentId:'EQ-1'},{equipmentId:'',expectedVersion:0},{equipmentId:'EQ-1',expectedVersion:-1},{equipmentId:'EQ-1',expectedVersion:1.5},{equipmentId:'EQ-1',expectedVersion:0,x:1}])assert.throws(()=>validateClaimInput(bad));
});
test('the summary comes only from item states',()=>{
 assert.deepEqual(summarize([]),{status:'open',total:0,open:0,assigned:0});
 assert.equal(summarize([{state:'open'},{state:'open'}]).status,'open');
 assert.deepEqual(summarize([{state:'assigned'},{state:'open'}]),{status:'partially-assigned',total:2,open:1,assigned:1});
 assert.equal(summarize([{state:'assigned'},{state:'assigned'}]).status,'assigned');
});
test('every claim error has an HTTP status',()=>{
 for(const [code,status] of Object.entries(CLAIM_ERRORS)){assert.match(code,/^[a-z_]+$/);assert.ok([404,409,422].includes(status),code);}
});
