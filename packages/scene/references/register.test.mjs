import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {registerURL, sceneSnapshot, validateRegister} from './validate.mjs';

const load = () => JSON.parse(readFileSync(registerURL, 'utf8'));
const reject = (edit, pattern) => {
  const register = load();
  edit(register);
  assert.throws(() => validateRegister(register), pattern);
};

test('baseline covers rooms, locations, ten models and procedural geometry without measured claims', () => {
  const register = load(), summary = validateRegister(register);
  assert.deepEqual(summary, {status:'blocked-external-evidence', measured:0, estimated:34, conventions:1, qualitativeClaims:5, artifacts:20});
  assert.equal(register.elements.filter(e => e.kind === 'room').length, 10);
  assert.equal(register.elements.filter(e => e.kind === 'supply-location').length, 9);
  assert.equal(register.elements.filter(e => e.kind === 'equipment-model').length, 10);
});

test('cannot promote an illustrative room or GLB model to measured or high confidence', () => {
  for (const id of ['room-101', 'model:incubator']) {
    reject(r => { r.elements.find(e => e.id === id).basis = 'measured'; }, /No approved measured evidence/);
    reject(r => { r.elements.find(e => e.id === id).confidence = 'high'; }, /No approved measured evidence/);
  }
});

test('qualitative sources and public tower map cannot authenticate geometry', () => {
  for (const id of ['parent-guide-2024', 'tower-map']) {
    reject(r => { r.elements[0].sourceIds = [id]; }, /Public qualitative sources cannot establish/);
  }
  reject(r => { r.sources.find(s => s.id === 'tower-map').dimensionalEvidence = true; }, /No dimensional evidence/);
  reject(r => { r.qualitativeClaims[0].sourceIds = ['tower-map']; }, /needs a qualitative source/);
});

test('missing, duplicate and stale element records fail rather than silently inherit confidence', () => {
  reject(r => r.elements.pop(), /coverage/);
  reject(r => { r.elements[1] = r.elements[0]; }, /duplicate ID/);
  reject(r => { r.elements.find(e => e.id === 'room-101').modelValues.x += 1; }, /Model snapshot changed/);
  const snapshot = sceneSnapshot();
  snapshot.elements.push({id:'new-room', kind:'room', modelValues:{}});
  assert.throws(() => validateRegister(load(), snapshot), /coverage/);
});

test('source, geometry, navigation and exported artifact drift requires renewed reference review', () => {
  for (const path of ['data.js', 'ward.js', 'nav.js', 'assets/manifest.json', 'assets/incubator.glb', 'assets/nicu-ward.glb']) {
    const snapshot = sceneSnapshot();
    snapshot.artifacts.find(a => a.path === path).sha256 = '0'.repeat(64);
    assert.throws(() => validateRegister(load(), snapshot), /Scene artifacts changed/);
  }
  reject(r => r.artifacts.pop(), /Scene artifacts changed/);
});

test('cannot record authorized review, remove blockers or claim architectural accuracy without evidence', () => {
  reject(r => { r.validation.status = 'validated'; }, /must remain blocked/);
  reject(r => { r.validation.authorizedReview = {approved:true}; }, /must remain blocked/);
  reject(r => { r.validation.architecturalAccuracyClaimed = true; }, /not established/);
  reject(r => { r.validation.requiredEvidence = []; }, /Missing external evidence requirement/);
});

test('every shipped public source requires a dated locator and limitations', () => {
  reject(r => r.sources.pop(), /Missing dated public-source review/);
  reject(r => { r.sources[1].locator = ''; }, /Missing dated public-source review/);
  reject(r => { r.sources[1].limitation = ''; }, /No dimensional evidence/);
  reject(r => { r.qualitativeClaims[0].sourceIds = ['unknown']; }, /needs a qualitative source/);
});

test('CLI distinguishes register consistency from the blocked authorized acceptance gate', () => {
  const command = fileURLToPath(new URL('./validate.mjs', import.meta.url));
  const consistency = spawnSync(process.execPath, [command], {encoding:'utf8', windowsHide:true});
  assert.equal(consistency.status, 0, consistency.stderr);
  assert.match(consistency.stdout, /not architectural sign-off/);
  const gate = spawnSync(process.execPath, [command, '--require-authorized'], {encoding:'utf8', windowsHide:true});
  assert.equal(gate.status, 2, gate.stderr);
  assert.match(gate.stdout, /BLOCKED/);
});
