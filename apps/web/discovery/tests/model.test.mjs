// Deterministic model tests for SV-030. Pure: no DOM, network, timers or credentials.
// Run: node --test apps/web/discovery/tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiscoveryModel,matches,countLocationStates,groupByType,locationState,normalizeItem,LIMITS,ERROR_CODES} from '../model.js';

const item = (id, label, equipmentType, locationId, readiness, freshness) => ({id, label, equipmentType, locationId, readiness, freshness});
const FIXTURE = [
  item('EQ-001', 'Transport incubator', 'incubator', 'equipment-store', 'ready', 'fresh'),
  item('EQ-002', 'Infusion pump 01', 'infusion', 'room-101', 'ready', 'aging'),
  item('EQ-003', 'Infusion pump 02', 'infusion', 'equipment-store', 'not-ready', 'stale'),
  item('EQ-004', 'Portable monitor 01', 'monitor', '', 'ready', 'unknown'),
  item('EQ-005', 'Portable monitor 02', 'monitor', 'equipment-store', 'unknown', 'unknown'),
  item('EQ-006', 'Radiant warmer', 'warmer', 'room-103', 'not-ready', 'fresh'),
].map(normalizeItem);
const ids = list => list.map(i => i.id);
function recorder() {
  const calls = {highlight: [], select: []};
  return {calls, onHighlight: v => calls.highlight.push(v), onSelect: v => calls.select.push(v)};
}

test('search matches stable ID, label and equipment type, case-insensitively, all terms required', () => {
  assert.deepEqual(ids(matches(FIXTURE, 'eq-003')), ['EQ-003']);
  assert.deepEqual(ids(matches(FIXTURE, 'INFUSION')), ['EQ-002', 'EQ-003']);
  assert.deepEqual(ids(matches(FIXTURE, 'pump 02')), ['EQ-002', 'EQ-003']);   // "02" is in EQ-002's ID and in EQ-003's label
  assert.deepEqual(ids(matches(FIXTURE, 'pump 01')), ['EQ-002']);              // every term must match somewhere
  assert.deepEqual(ids(matches(FIXTURE, 'monitor 01')), ['EQ-004']);
  assert.deepEqual(ids(matches(FIXTURE, '  ')), ids(FIXTURE));
  assert.deepEqual(ids(matches(FIXTURE, 'no such thing')), []);
});

test('location, readiness and freshness filters are independent and combine with search', () => {
  assert.deepEqual(ids(matches(FIXTURE, '', {location: 'equipment-store'})), ['EQ-001', 'EQ-003', 'EQ-005']);
  assert.deepEqual(ids(matches(FIXTURE, '', {readiness: 'ready'})), ['EQ-001', 'EQ-002', 'EQ-004']);
  assert.deepEqual(ids(matches(FIXTURE, '', {freshness: 'unknown'})), ['EQ-004', 'EQ-005']);
  assert.deepEqual(ids(matches(FIXTURE, '', {location: 'equipment-store', readiness: 'ready'})), ['EQ-001']);
  assert.deepEqual(ids(matches(FIXTURE, 'infusion', {readiness: 'not-ready'})), ['EQ-003']);
  // Freshness does not imply readiness and readiness does not imply location: each field filters only itself.
  assert.deepEqual(ids(matches(FIXTURE, '', {freshness: 'fresh'})), ['EQ-001', 'EQ-006']);
  assert.deepEqual(ids(matches(FIXTURE, '', {freshness: 'fresh', readiness: 'not-ready'})), ['EQ-006']);
});

test('unknown and stale items stay in the totals and the three counts add up', () => {
  const counts = countLocationStates(FIXTURE);
  assert.deepEqual(counts, {total: 6, located: 3, stale: 1, unknown: 2});
  assert.equal(counts.total, counts.located + counts.stale + counts.unknown);
  assert.equal(locationState(FIXTURE[3]), 'unknown');   // no location recorded
  assert.equal(locationState(FIXTURE[4]), 'unknown');   // freshness unknown
  assert.equal(locationState(FIXTURE[2]), 'stale');
  assert.equal(locationState(FIXTURE[1]), 'located');   // "aging" still has a recorded, non-stale location
  // A "ready" item with an unknown location is counted as unknown: location is never read as readiness, nor readiness as location.
  assert.equal(locationState(FIXTURE[3]), 'unknown'); assert.equal(FIXTURE[3].readiness, 'ready');
  const model = createDiscoveryModel(); model.setItems(FIXTURE); model.setFilter('freshness', 'stale');
  assert.deepEqual(model.snapshot().counts, {total: 1, located: 0, stale: 1, unknown: 0});
  model.destroy();
});

test('normalization is defensive: bad records are dropped, missing values are labelled unknown, duplicates are dropped', () => {
  const model = createDiscoveryModel();
  model.setItems([null, 5, {}, {id: '  '}, {id: 'A'}, {id: 'A', label: 'duplicate'}, {id: 'B', label: 'x'.repeat(500), locationId: 7}]);
  const s = model.snapshot();
  assert.deepEqual(ids(s.results), ['A', 'B']);
  assert.deepEqual([s.results[0].label, s.results[0].readiness, s.results[0].freshness], ['A', 'unknown', 'unknown']);
  assert.equal(s.results[1].label.length, 200); assert.equal(s.results[1].locationId, '');
  model.setItems('not a list'); assert.deepEqual(model.snapshot().results, []);
  // SV-032: an oversized input used to be silently cut to the bound and reported as a complete list. It is now refused (see the size-bound test).
  model.setItems(Array.from({length: LIMITS.maxItems + 50}, (_, i) => ({id: `X${i}`}))); assert.deepEqual([model.snapshot().phase, model.snapshot().errorCode, model.snapshot().authorizedTotal], ['error', 'too_large', 0]);
  model.setItems(Array.from({length: LIMITS.maxItems}, (_, i) => ({id: `X${i}`}))); assert.deepEqual([model.snapshot().phase, model.snapshot().authorizedTotal], ['ready', LIMITS.maxItems]);
  model.destroy();
});

test('groups by type with per-group counts; groups and matching IDs follow the filters', () => {
  const groups = groupByType(FIXTURE);
  assert.deepEqual(groups.map(g => g.type), ['incubator', 'infusion', 'monitor', 'warmer']);
  assert.deepEqual(groups[2], {type: 'monitor', ids: ['EQ-004', 'EQ-005'], counts: {total: 2, located: 0, stale: 0, unknown: 2}});
  const model = createDiscoveryModel(); model.setItems(FIXTURE); model.setQuery('infusion');
  const s = model.snapshot();
  assert.deepEqual(s.groups.map(g => g.type), ['infusion']); assert.deepEqual(s.matchingIds, ['EQ-002', 'EQ-003']);
  assert.deepEqual(s.options, {location: ['equipment-store', 'room-101', 'room-103'], readiness: ['not-ready', 'ready', 'unknown'], freshness: ['aging', 'fresh', 'stale', 'unknown']});
  model.destroy();
});

test('selected instance is distinct from the highlighted group and callbacks report stable IDs', () => {
  const r = recorder(), model = createDiscoveryModel(r);
  model.setItems(FIXTURE);
  model.highlightGroup('infusion');
  assert.deepEqual(r.calls.highlight.at(-1), ['EQ-002', 'EQ-003']);
  model.selectInstance('EQ-006');                       // an instance outside the highlighted group
  let s = model.snapshot();
  assert.equal(s.selectedId, 'EQ-006'); assert.deepEqual(s.highlight, {type: 'infusion', ids: ['EQ-002', 'EQ-003']});
  assert.deepEqual(r.calls.select, ['EQ-006']);
  model.selectInstance('EQ-NOPE'); model.selectInstance(42); model.highlightGroup('no-such-type');   // ignored
  s = model.snapshot(); assert.equal(s.selectedId, 'EQ-006'); assert.equal(s.highlight.type, 'infusion');
  model.selectInstance(null); assert.deepEqual(r.calls.select, ['EQ-006', null]);
  model.highlightGroup(null); assert.deepEqual(r.calls.highlight.at(-1), []);
  model.destroy();
});

test('changing the search or any filter clears the highlight; selection survives while still authorized', () => {
  const r = recorder(), model = createDiscoveryModel(r);
  model.setItems(FIXTURE); model.selectInstance('EQ-001');
  for (const change of [() => model.setQuery('pump'), () => model.setFilter('location', 'room-101'), () => model.setFilter('readiness', 'ready'), () => model.setFilter('freshness', 'aging'), () => model.clearFilters()]) {
    model.clearFilters(); model.highlightGroup('infusion'); assert.ok(model.snapshot().highlight, 'highlight set');
    change();
    assert.equal(model.snapshot().highlight, null); assert.deepEqual(r.calls.highlight.at(-1), []);
  }
  assert.equal(model.snapshot().selectedId, 'EQ-001', 'selection is not tied to the filters');
  model.destroy();
});

test('a refresh removes no-longer-authorized IDs from results, selection and highlight', () => {
  const r = recorder(), model = createDiscoveryModel(r);
  model.setItems(FIXTURE); model.selectInstance('EQ-003'); model.highlightGroup('infusion');
  assert.deepEqual(r.calls.highlight.at(-1), ['EQ-002', 'EQ-003']);
  model.setItems(FIXTURE.filter(i => i.id !== 'EQ-003'));
  let s = model.snapshot();
  assert.equal(s.selectedId, null); assert.deepEqual(r.calls.select.at(-1), null);
  assert.deepEqual(s.highlight, {type: 'infusion', ids: ['EQ-002']}); assert.deepEqual(r.calls.highlight.at(-1), ['EQ-002']);
  assert.ok(!s.matchingIds.includes('EQ-003'));
  model.setItems(FIXTURE.filter(i => i.equipmentType !== 'infusion'));   // the whole highlighted group disappears
  s = model.snapshot(); assert.equal(s.highlight, null); assert.deepEqual(r.calls.highlight.at(-1), []);
  model.setItems([]); s = model.snapshot(); assert.deepEqual([s.authorizedTotal, s.results.length], [0, 0]);
  model.destroy();
});

test('losing access clears everything; other failures keep a flagged list; stale callbacks are ignored', () => {
  const r = recorder(), model = createDiscoveryModel(r);
  model.setItems(FIXTURE); model.selectInstance('EQ-001'); model.highlightGroup('monitor');
  let token = model.beginRefresh();
  assert.equal(model.failRefresh(token, 'unavailable'), true);
  let s = model.snapshot();
  assert.deepEqual([s.phase, s.errorCode, s.outdated, s.authorizedTotal], ['error', 'unavailable', true, 6]);
  assert.equal(s.highlight, null, 'highlight is dropped when the list cannot be confirmed'); assert.equal(s.selectedId, 'EQ-001');
  token = model.beginRefresh();
  assert.equal(model.failRefresh(token, 'denied'), true);
  s = model.snapshot();
  assert.deepEqual([s.errorCode, s.outdated, s.authorizedTotal, s.results.length, s.selectedId], ['denied', false, 0, 0, null]);
  assert.deepEqual(r.calls.select.at(-1), null);
  assert.equal(model.failRefresh(token, 'bogus'), false, 'a token settles once: a second settlement is rejected');
  assert.equal(model.snapshot().errorCode, 'denied', 'and the earlier outcome stands');
  assert.equal(model.failRefresh(model.beginRefresh(), 'bogus'), true); assert.equal(model.snapshot().errorCode, 'unavailable', 'unknown codes become the generic one');
  // Out-of-order refreshes: only the newest token may deliver.
  const first = model.beginRefresh(), second = model.beginRefresh();
  assert.equal(model.finishRefresh(second, FIXTURE.slice(0, 2)), true);
  assert.equal(model.finishRefresh(first, FIXTURE), false, 'older refresh is ignored');
  assert.equal(model.failRefresh(first, 'denied'), false);
  assert.equal(model.snapshot().authorizedTotal, 2);
  model.destroy();
});

test('destroy clears callbacks once, drops data and makes every later call a no-op', () => {
  const r = recorder(), model = createDiscoveryModel(r);
  model.setItems(FIXTURE); model.selectInstance('EQ-002'); model.highlightGroup('infusion');
  const pending = model.beginRefresh();
  let renders = 0; model.subscribe(() => renders++);
  model.destroy();
  assert.deepEqual(r.calls.highlight.at(-1), []); assert.deepEqual(r.calls.select.at(-1), null);
  const before = [r.calls.highlight.length, r.calls.select.length, renders];
  assert.equal(model.finishRefresh(pending, FIXTURE), false);
  model.setItems(FIXTURE); model.setQuery('x'); model.setFilter('location', 'y'); model.clearFilters(); model.selectInstance('EQ-001'); model.highlightGroup('infusion'); model.destroy();
  assert.deepEqual([r.calls.highlight.length, r.calls.select.length, renders], before);
  const s = model.snapshot(); assert.deepEqual([s.authorizedTotal, s.results.length, s.selectedId, s.highlight], [0, 0, null, null]);
});

test('a throwing callback cannot corrupt the model, and unsubscribe works', () => {
  const model = createDiscoveryModel({onHighlight: () => { throw new Error('boom'); }, onSelect: () => { throw new Error('boom'); }});
  model.setItems(FIXTURE); model.selectInstance('EQ-001'); model.highlightGroup('infusion');
  const s = model.snapshot(); assert.equal(s.selectedId, 'EQ-001'); assert.deepEqual(s.highlight.ids, ['EQ-002', 'EQ-003']);
  let n = 0; const off = model.subscribe(() => { n++; throw new Error('listener'); });
  model.setQuery('a'); off(); model.setQuery('b');
  assert.equal(n, 1); model.destroy();
});

test('invalid filter names and values cannot change the filters', () => {
  const model = createDiscoveryModel(); model.setItems(FIXTURE);
  model.setFilter('__proto__', 'x'); model.setFilter('status', 'x'); model.setFilter('location', 5);
  assert.deepEqual(model.snapshot().filters, {location: '', readiness: '', freshness: ''});
  model.setQuery('q'.repeat(500)); assert.equal(model.snapshot().query.length, LIMITS.maxQuery);
  model.destroy();
});

// ---- SV-032 repairs: one settlement per refresh, reentrancy, and a truthful size bound ----
test('a refresh settles once: denial then a late success cannot bring records, selection or highlight back', () => {
  const r = recorder(), model = createDiscoveryModel(r);
  model.setItems(FIXTURE); model.selectInstance('EQ-003'); model.highlightGroup('infusion');
  const token = model.beginRefresh();
  assert.equal(model.failRefresh(token, 'denied'), true);
  assert.deepEqual([model.snapshot().authorizedTotal, model.snapshot().selectedId, model.snapshot().highlight], [0, null, null]);
  const calls = [r.calls.highlight.length, r.calls.select.length];
  assert.equal(model.finishRefresh(token, FIXTURE), false, 'late success on the same token is rejected');
  assert.equal(model.failRefresh(token, 'unavailable'), false);
  const s = model.snapshot();
  assert.deepEqual([s.phase, s.errorCode, s.authorizedTotal, s.results.length, s.selectedId, s.highlight], ['error', 'denied', 0, 0, null, null]);
  assert.deepEqual([r.calls.highlight.length, r.calls.select.length], calls, 'no callback fired for the rejected settlement');
  // A genuinely new authorized refresh still works.
  const next = model.beginRefresh();
  assert.equal(model.finishRefresh(next, FIXTURE.slice(0, 2)), true);
  assert.deepEqual([model.snapshot().phase, model.snapshot().authorizedTotal], ['ready', 2]);
  model.destroy();
});

test('success then a late error, or a repeated completion, is rejected', () => {
  const model = createDiscoveryModel();
  const token = model.beginRefresh();
  assert.equal(model.finishRefresh(token, FIXTURE), true);
  assert.equal(model.failRefresh(token, 'denied'), false, 'late error after success');
  assert.equal(model.finishRefresh(token, FIXTURE.slice(0, 1)), false, 'repeated completion');
  const s = model.snapshot();
  assert.deepEqual([s.phase, s.errorCode, s.authorizedTotal, s.refreshing], ['ready', null, 6, false]);
  // A token that was never issued, or issued before this one, settles nothing.
  assert.equal(model.finishRefresh(0, FIXTURE), false); assert.equal(model.finishRefresh(999, FIXTURE), false); assert.equal(model.finishRefresh('1', FIXTURE), false);
  model.destroy();
});

test('a reentrant subscriber cannot settle the previous refresh or clear the new refreshing state', () => {
  const model = createDiscoveryModel();
  const first = model.beginRefresh();
  const attempts = [];
  model.subscribe(() => { if (!attempts.length) attempts.push(model.finishRefresh(first, FIXTURE), model.failRefresh(first, 'denied')); });
  const second = model.beginRefresh();          // the subscriber runs during this call and tries to settle `first`
  assert.deepEqual(attempts, [false, false], 'the old token was already superseded when subscribers ran');
  let s = model.snapshot();
  assert.deepEqual([s.refreshing, s.phase, s.authorizedTotal], [true, 'loading', 0], 'still refreshing; nothing was loaded by the old token');
  assert.equal(model.finishRefresh(second, FIXTURE), true);
  s = model.snapshot(); assert.deepEqual([s.refreshing, s.phase, s.authorizedTotal], [false, 'ready', 6]);
  model.destroy();
});

test('a token is consumed before listeners run, so a listener cannot settle it again', () => {
  const model = createDiscoveryModel();
  const token = model.beginRefresh();
  const again = [];
  model.subscribe(() => { if (model.snapshot().phase === 'ready' && !again.length) again.push(model.finishRefresh(token, []), model.failRefresh(token, 'denied')); });
  assert.equal(model.finishRefresh(token, FIXTURE), true);
  assert.deepEqual(again, [false, false]);
  assert.deepEqual([model.snapshot().phase, model.snapshot().authorizedTotal], ['ready', 6]);
  model.destroy();
});

test('the size bound is explicit: 5000 items are accepted, 5001 are rejected and never shown as a complete list', () => {
  const make = n => Array.from({length: n}, (_, i) => ({id: `E${String(i).padStart(5, '0')}`, label: `Item ${i}`, equipmentType: 'pump', locationId: i === n - 1 && n > 5000 ? '' : 'store', readiness: 'ready', freshness: i === n - 1 && n > 5000 ? 'unknown' : 'fresh'}));
  const at = createDiscoveryModel(); at.setItems(make(LIMITS.maxItems));
  let s = at.snapshot();
  assert.deepEqual([s.phase, s.authorizedTotal, s.counts.total, s.errorCode], ['ready', 5000, 5000, null]);
  at.setQuery('E04999'); assert.equal(at.snapshot().results.length, 1, 'search reaches the last item at the bound');
  at.destroy();
  const over = createDiscoveryModel(), r = recorder(); over.setItems(make(100));
  const token = over.beginRefresh();
  assert.equal(over.finishRefresh(token, make(LIMITS.maxItems + 1)), true, 'the refresh settled (as a refusal)');
  s = over.snapshot();
  assert.equal(s.phase, 'error'); assert.equal(s.errorCode, 'too_large');
  assert.ok(ERROR_CODES.includes('too_large'));
  assert.equal(s.authorizedTotal, 100, 'the last loaded list is kept, flagged as out of date'); assert.equal(s.outdated, true);
  assert.ok(!s.matchingIds.includes('E05000'), 'the 5001st item is not silently in or out of the list');
  over.setQuery('E05000'); s = over.snapshot();
  assert.equal(s.phase, 'error', 'a search cannot turn the refusal into a complete "no match" result'); assert.equal(s.results.length, 0);
  over.destroy();
  // With nothing loaded before, the refusal leaves an empty list that is plainly an error, not "ready".
  const fresh = createDiscoveryModel();
  fresh.setItems(make(LIMITS.maxItems + 1)); s = fresh.snapshot();
  assert.deepEqual([s.phase, s.errorCode, s.authorizedTotal, s.outdated], ['error', 'too_large', 0, false]);
  fresh.destroy();
  // The caller can also report it.
  const reported = createDiscoveryModel(); assert.equal(reported.failRefresh(reported.beginRefresh(), 'too_large'), true); assert.equal(reported.snapshot().errorCode, 'too_large'); reported.destroy();
  void r;
});
