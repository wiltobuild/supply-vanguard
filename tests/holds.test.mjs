// Included in the repository's required `npm test` command. The database-backed tests skip themselves when their
// dependency (PGlite, or native PostgreSQL) is not installed.
import '../services/api/holds/tests/holds.test.mjs';
import '../services/api/holds/tests/hold-race.native.test.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HOLD_KINDS,ASSIGNABLE_ROLES,HOLD_ERRORS,validateHoldInput,validateRuleInput,summarizeHolds} from '../packages/domain/holds/index.js';
import {ROLE_PERMISSIONS} from '../services/api/auth/roles.mjs';
import {CLAIM_ERRORS} from '../packages/domain/requests/index.js';
test('hold input and rules are validated against the existing roles',()=>{
 assert.deepEqual(HOLD_KINDS,['dirty','fault','maintenance','unknown']);
 assert.deepEqual([...ASSIGNABLE_ROLES].sort(),Object.keys(ROLE_PERMISSIONS).sort(),'the role list must equal the SV-005 roles');
 assert.deepEqual(validateHoldInput({kind:'dirty'}),{kind:'dirty',reason:undefined});
 for(const bad of [null,[],{},{kind:'x'},{kind:'dirty',reason:5},{kind:'dirty',reason:'x'.repeat(501)},{kind:'dirty',extra:1}])assert.throws(()=>validateHoldInput(bad),undefined,JSON.stringify(bad)?.slice(0,40));
 assert.deepEqual(validateRuleInput('fault',{role:'admin'}),{kind:'fault',role:'admin'});
 for(const [k,b] of [['x',{role:'admin'}],['fault',{}],['fault',{role:'janitor'}],['fault',{role:'admin',x:1}],['fault',null]])assert.throws(()=>validateRuleInput(k,b));
});
test('the summary lists active kinds in a fixed order and counts history',()=>{
 assert.deepEqual(summarizeHolds([]),{blocked:false,activeKinds:[],active:0,total:0});
 assert.deepEqual(summarizeHolds([{kind:'unknown',active:true},{kind:'dirty',active:true},{kind:'fault',active:false}]),{blocked:true,activeKinds:['dirty','unknown'],active:2,total:3});
});
test('error codes map to HTTP statuses, and assignment blocking is a known claim error',()=>{
 for(const status of Object.values(HOLD_ERRORS))assert.ok([403,404,409,422].includes(status));
 assert.equal(CLAIM_ERRORS.equipment_on_hold,422);
});
