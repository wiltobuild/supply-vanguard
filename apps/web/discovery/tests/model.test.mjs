// Deterministic model tests for SV-030. Pure: no DOM, network, timers or credentials.
// Run: node --test apps/web/discovery/tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiscoveryModel,matches,countLocationStates,groupByType,locationState,normalizeItem,LIMITS} from '../model.js';

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
  model.setItems(Array.from({length: LIMITS.maxItems + 50}, (_, i) => ({id: `X${i}`}))); assert.equal(model.snapshot().authorizedTotal, LIMITS.maxItems);
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
  assert.equal(model.failRefresh(token, 'bogus'), true); assert.equal(model.snapshot().errorCode, 'unavailable', 'unknown codes become the generic one');
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
