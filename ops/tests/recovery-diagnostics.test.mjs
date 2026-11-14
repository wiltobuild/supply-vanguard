import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  diagnosticLimits, snapshotMismatchDiagnostics, SnapshotMismatchError,
  mismatchDiagnosticLine, retainMismatchDiagnostics,
} from '../recovery-diagnostics.mjs';
import {verifySnapshot} from '../recovery-integrity.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const missingHash = createHash('sha256').update('<missing>').digest('hex');
const mismatch = (before, after, phase) => {
  let failure;
  try { verifySnapshot(before, after, {phase}); } catch (error) { failure = error; }
  assert.ok(failure instanceof SnapshotMismatchError);
  assert.equal(failure.message, 'Restored data or security/schema metadata differs');
  return failure;
};
const assertBounded = receipt => {
  assert.ok(receipt.differences.length <= diagnosticLimits.entries);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= diagnosticLimits.bytes);
  for (const item of receipt.differences) {
    assert.ok(item.path.length <= diagnosticLimits.pathCharacters);
    assert.match(item.beforeSha256, /^[a-f0-9]{64}$/);
    assert.match(item.afterSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(item.beforeSha256, item.afterSha256);
  }
};

test('both native comparison phases report the exact changed row field and hashes', () => {
  const before = {tables: {equipment: [{id: 'fixture-equipment', status: 'available'}]}};
  const after = structuredClone(before); after.tables.equipment[0].status = 'maintenance';
  for (const phase of ['post-restore', 'post-protection-probes']) {
    const failure = mismatch(before, after, phase), receipt = failure.diagnostics;
    assert.equal(receipt.phase, phase);
    assert.equal(receipt.beforeSha256, hash(before));
    assert.equal(receipt.afterSha256, hash(after));
    assert.deepEqual(receipt.differences, [{kind: 'value', path: '$.tables.equipment[0].status',
      beforeSha256: hash('available'), afterSha256: hash('maintenance')}]);
    assert.equal(receipt.truncated, false);
    assert.equal(mismatchDiagnosticLine(failure), 'Recovery comparison diagnostics: ' + JSON.stringify(receipt));
  }
});

test('function body, ACL and RLS differences identify structure without disclosing values', () => {
  const before = {metadata: {functions: [{definition: 'SELECT private_function_body_before()', acl: ['private-owner=X/private-owner']}],
    rls: [{table: 'equipment', forced: true}]}};
  const after = structuredClone(before);
  after.metadata.functions[0].definition = 'SELECT private_function_body_after()';
  after.metadata.functions[0].acl[0] = 'private-recipient=X/private-owner';
  after.metadata.rls[0].forced = false;
  const failure = mismatch(before, after, 'post-restore'), receipt = failure.diagnostics;
  assert.deepEqual(receipt.differences.map(item => item.path), [
    '$.metadata.functions[0].definition', '$.metadata.functions[0].acl[0]', '$.metadata.rls[0].forced',
  ]);
  assert.equal(receipt.differences[0].beforeSha256, hash(before.metadata.functions[0].definition));
  assert.equal(receipt.differences[1].afterSha256, hash(after.metadata.functions[0].acl[0]));
  const output = mismatchDiagnosticLine(failure);
  for (const secret of ['SELECT', 'private_function_body', 'private-owner', 'private-recipient']) assert.ok(!output.includes(secret));
  assertBounded(receipt);
});

test('missing rows and fields have distinct presence hashes and stable structural paths', () => {
  const before = {tables: {equipment: [{id: 'fixture-first'}, {id: 'fixture-second'}]}};
  const after = {tables: {equipment: [{id: 'fixture-first', note: null}]}};
  const receipt = snapshotMismatchDiagnostics(before, after, {phase: 'post-restore'});
  assert.deepEqual(receipt.differences, [
    {kind: 'missing', path: '$.tables.equipment[0].note', beforeSha256: missingHash, afterSha256: hash(null)},
    {kind: 'missing', path: '$.tables.equipment[1]', beforeSha256: hash(before.tables.equipment[1]), afterSha256: missingHash},
  ]);
  assertBounded(receipt);
});

test('the existing strict JSON ordering and type comparison remain fail-closed', () => {
  const before = {tables: {}, metadata: {}}, reordered = {metadata: {}, tables: {}};
  const ordered = mismatch(before, reordered, 'post-restore').diagnostics;
  assert.deepEqual(ordered.differences, [{kind: 'key-order', path: '$', beforeSha256: hash(before), afterSha256: hash(reordered)}]);
  assert.equal(ordered.truncated, false);
  for (const [left, right] of [[1, '1'], [null, {}], [[], {}]]) {
    assert.equal(mismatch(left, right, 'post-protection-probes').diagnostics.differences[0].kind, 'value');
  }
});

test('arbitrary keys, values and phase text cannot enter diagnostic output', () => {
  const secrets = ['postgresql://private-user:private-password@private-host/private-db',
    'SELECT private_sql_body FROM private_table', 'private-tenant-900', 'Bearer private-token-900'];
  const before = {tables: {equipment: [{id: secrets[2], [secrets[0]]: {[secrets[1]]: secrets[3]}}]}};
  const after = structuredClone(before); after.tables.equipment[0][secrets[0]][secrets[1]] = 'private-new-value';
  const failure = mismatch(before, after, secrets.join('\n'));
  const output = [failure.message, failure.stack, JSON.stringify(failure), mismatchDiagnosticLine(failure)].join('\n');
  for (const secret of [...secrets, 'private-new-value']) assert.ok(!output.includes(secret));
  assert.equal(failure.diagnostics.phase, 'unspecified');
  assert.deepEqual(failure.diagnostics.differences.map(item => item.path), ['$.tables.equipment[0].property[1].property[0]']);
  assert.equal(Object.hasOwn(failure, 'before'), false);
  assert.equal(Object.hasOwn(failure, 'after'), false);
  assert.equal(Object.hasOwn(failure, 'cause'), false);
  assertBounded(failure.diagnostics);
});

test('entry limits retain accurate differences while bounding a large multi-row mismatch', () => {
  const before = {tables: {equipment: Array.from({length: 1000}, () => ({note: 'private-old'}))}};
  const after = {tables: {equipment: Array.from({length: 1000}, () => ({note: 'private-new'}))}};
  const receipt = snapshotMismatchDiagnostics(before, after, {phase: 'post-restore'});
  assert.equal(receipt.differences.length, diagnosticLimits.entries);
  assert.equal(receipt.truncated, true);
  receipt.differences.forEach((item, index) => {
    assert.equal(item.path, `$.tables.equipment[${index}].note`);
    assert.equal(item.beforeSha256, hash('private-old'));
    assert.equal(item.afterSha256, hash('private-new'));
  });
  assertBounded(receipt);
});

test('depth and path limits report a genuinely different enclosing subtree', () => {
  const nested = (key, leaf, count) => {
    for (let index = 0; index < count; index++) leaf = {[key]: leaf};
    return leaf;
  };
  const cases = [
    ['note', diagnosticLimits.depth + 10, 'depth-limit'],
    ['equipment_command_receipt', 10, 'path-limit'],
  ];
  for (const [key, depth, kind] of cases) {
    const before = nested(key, 'private-old', depth), after = nested(key, 'private-new', depth);
    const receipt = snapshotMismatchDiagnostics(before, after, {phase: 'post-restore'});
    assert.equal(receipt.truncated, true);
    assert.equal(receipt.differences[0].kind, kind);
    const item = receipt.differences[0], steps = item.path.split('.').length - 1;
    assert.equal(item.beforeSha256, hash(nested(key, 'private-old', depth - steps)));
    assert.equal(item.afterSha256, hash(nested(key, 'private-new', depth - steps)));
    assertBounded(receipt);
  }
});

test('node budget reports the mismatching parent rather than an equal scanned sibling', () => {
  const before = Array(diagnosticLimits.nodes + 10).fill('private-equal');
  const after = [...before]; after[after.length - 1] = 'private-different';
  const receipt = snapshotMismatchDiagnostics(before, after, {phase: 'post-protection-probes'});
  assert.deepEqual(receipt.differences, [{kind: 'node-limit', path: '$', beforeSha256: hash(before), afterSha256: hash(after)}]);
  assert.equal(receipt.truncated, true);
  assertBounded(receipt);
});

test('untrusted diagnostic properties are ignored and immutable receipts survive cleanup failure', () => {
  const forged = Object.assign(Error('cleanup failure'), {diagnostics: {phase: 'private-token', before: 'private-row'}});
  assert.equal(mismatchDiagnosticLine(forged), null);
  const failure = mismatch({note: 'private-old'}, {note: 'private-new'}, 'post-restore');
  const saved = mismatchDiagnosticLine(failure);
  assert.throws(() => { failure.diagnostics.phase = 'private-token'; }, TypeError);
  assert.throws(() => { failure.diagnostics.differences[0].path = 'private-row'; }, TypeError);
  assert.throws(() => { failure.diagnostics.differences.push({}); }, TypeError);
  assert.throws(() => { failure.diagnostics = {}; }, TypeError);
  const cleanup = Error('Cleanup incomplete; no pass recorded');
  assert.equal(retainMismatchDiagnostics(cleanup, failure), cleanup);
  assert.equal(cleanup.message, 'Cleanup incomplete; no pass recorded');
  assert.equal(mismatchDiagnosticLine(cleanup), saved);
  assert.equal(retainMismatchDiagnostics(forged, Error('unrelated')), forged);
  assert.equal(mismatchDiagnosticLine(forged), null);
});
