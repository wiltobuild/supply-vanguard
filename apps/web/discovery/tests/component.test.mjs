// DOM tests for the SV-030 discovery component. They need jsdom, which is NOT installed by this task. The test looks for a copy that
// other tasks already installed; if none is found, the DOM tests are SKIPPED and say so (model tests still run). Nothing is installed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join,resolve} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../../..');
function findJsdom() {
  for (const base of [here, join(root, 'services/api/check-in'), join(root, 'services/api/maintenance'), root]) {
    try { return createRequire(join(base, 'noop.js'))('jsdom'); } catch { /* try the next place */ }
  }
  return null;
}
const jsdom = findJsdom();
const skip = jsdom ? false : 'jsdom is not installed anywhere this task may look; DOM tests skipped (model tests still ran). Install nothing: report it.';
const {mountDiscovery} = await import(pathToFileURL(join(here, '../component.js')).href);

const ITEMS = [
  {id: 'EQ-001', label: 'Transport incubator', equipmentType: 'incubator', locationId: 'equipment-store', readiness: 'ready', freshness: 'fresh'},
  {id: 'EQ-002', label: 'Infusion pump 01', equipmentType: 'infusion', locationId: 'room-101', readiness: 'ready', freshness: 'aging'},
  {id: 'EQ-003', label: 'Infusion pump 02', equipmentType: 'infusion', locationId: 'equipment-store', readiness: 'not-ready', freshness: 'stale'},
  {id: 'EQ-004', label: 'Portable monitor 01', equipmentType: 'monitor', locationId: '', readiness: 'ready', freshness: 'unknown'},
];
function setup(options = {}) {
  const dom = new jsdom.JSDOM('<!doctype html><body><div id="host"></div></body>');
  const {document, Event} = dom.window, host = document.getElementById('host'), calls = {highlight: [], select: [], retry: 0};
  const view = mountDiscovery(host, {document, onHighlight: v => calls.highlight.push(v), onSelect: v => calls.select.push(v), onRetry: () => calls.retry++, ...options});
  const $ = sel => host.querySelector(sel), $$ = sel => [...host.querySelectorAll(sel)];
  const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', {bubbles: true})); };
  const choose = (select, value) => { select.value = value; select.dispatchEvent(new Event('change', {bubbles: true})); };
  const ids = () => $$('[data-id]').map(b => b.dataset.id);
  return {dom, document, host, view, calls, $, $$, type, choose, ids};
}

test('shows a loading state, then the list with labelled controls and honest counts', {skip}, () => {
  const t = setup();
  assert.match(t.$('.discovery-state').textContent, /Loading/); assert.equal(t.$('.discovery-state').hidden, false);
  assert.equal(t.$('.discovery-results').getAttribute('aria-busy'), 'true');
  t.view.setItems(ITEMS);
  assert.equal(t.$('.discovery-state').hidden, true); assert.equal(t.$('.discovery-results').getAttribute('aria-busy'), 'false');
  assert.deepEqual(t.ids(), ['EQ-001', 'EQ-002', 'EQ-003', 'EQ-004']);
  assert.equal(t.$('.discovery-summary').textContent, '4 of 4 items match. Location: 2 located, 1 stale, 1 unknown.');
  // Readiness is shown as its own supplied field, separate from location and freshness.
  const first = t.$('[data-id="EQ-004"]').textContent;
  assert.match(first, /Location: not recorded/); assert.match(first, /Location freshness: unknown/); assert.match(first, /Readiness: ready/);
  // Every control is a native, labelled element and nothing forces a tab order.
  for (const control of t.$$('input, select')) assert.ok(t.$(`label[for="${control.id}"]`), `${control.id} has a label`);
  for (const control of t.$$('input, select, button')) assert.ok(!(control.tabIndex > 0), 'no positive tabindex');
  assert.ok(t.$$('button').every(b => b.type === 'button' && b.textContent.trim()), 'every button has a type and a text name');
  t.view.destroy();
});

test('supplied labels are rendered as text, never as HTML', {skip}, () => {
  const t = setup();
  const nasty = '<img src=x onerror="globalThis.hacked=1"><b>bold</b>';
  t.view.setItems([{id: 'EQ-9', label: nasty, equipmentType: nasty, locationId: nasty, readiness: nasty, freshness: nasty}]);
  assert.equal(t.$$('img, b').length, 0);
  assert.ok(t.$('[data-id="EQ-9"]').textContent.includes(nasty));
  assert.ok(t.$('.discovery-groups').textContent.includes(nasty));
  assert.ok([...t.$('select[data-filter="location"]').options].some(o => o.textContent === nasty));
  assert.equal(t.dom.window.hacked, undefined);
  t.view.destroy();
});

test('search and filters narrow the list; clear restores it and returns focus to search; empty state is shown', {skip}, () => {
  const t = setup(); t.view.setItems(ITEMS);
  t.type(t.$('input[type=search]'), 'pump'); assert.deepEqual(t.ids(), ['EQ-002', 'EQ-003']);
  t.choose(t.$('[data-filter=freshness]'), 'stale'); assert.deepEqual(t.ids(), ['EQ-003']);
  t.choose(t.$('[data-filter=location]'), 'room-101'); assert.deepEqual(t.ids(), []);
  assert.match(t.$('.discovery-state').textContent, /No equipment matches these filters/);
  assert.match(t.$('.discovery-summary').textContent, /^0 of 4 items match/);
  t.$('[data-action=clear]').click();
  assert.deepEqual(t.ids(), ['EQ-001', 'EQ-002', 'EQ-003', 'EQ-004']);
  assert.equal(t.$('input[type=search]').value, ''); assert.equal(t.$('[data-filter=location]').value, '');
  assert.equal(t.document.activeElement, t.$('input[type=search]'));
  t.view.setItems([]); assert.match(t.$('.discovery-state').textContent, /No equipment to show/);
  t.view.destroy();
});

test('selecting an instance and highlighting a group are separate, toggle, and report stable IDs', {skip}, () => {
  const t = setup(); t.view.setItems(ITEMS);
  t.$('[data-group="infusion"]').click();
  assert.deepEqual(t.calls.highlight.at(-1), ['EQ-002', 'EQ-003']); assert.equal(t.$('[data-group="infusion"]').getAttribute('aria-pressed'), 'true');
  t.$('[data-id="EQ-001"]').click();
  assert.deepEqual(t.calls.select, ['EQ-001']); assert.equal(t.$('[data-id="EQ-001"]').getAttribute('aria-pressed'), 'true');
  assert.equal(t.$('[data-group="infusion"]').getAttribute('aria-pressed'), 'true', 'group highlight is unaffected by selecting an instance');
  t.$('[data-id="EQ-001"]').click(); assert.deepEqual(t.calls.select, ['EQ-001', null]);
  t.$('[data-group="infusion"]').click(); assert.deepEqual(t.calls.highlight.at(-1), []);
  t.$('[data-group="infusion"]').click();
  t.type(t.$('input[type=search]'), 'monitor');
  assert.deepEqual(t.calls.highlight.at(-1), [], 'changing the search clears the obsolete highlight');
  assert.equal(t.$('[data-group="infusion"]'), null);
  t.view.destroy();
});

test('a refresh keeps the focused record\'s element, and moves focus into the list when that record disappears', {skip}, () => {
  const t = setup(); t.view.setItems(ITEMS);
  const button = t.$('[data-id="EQ-002"]'); button.focus(); assert.equal(t.document.activeElement, button);
  t.view.setItems(ITEMS.map(i => ({...i, freshness: 'fresh'})));
  assert.equal(t.$('[data-id="EQ-002"]'), button, 'same element, not rebuilt'); assert.equal(t.document.activeElement, button);
  assert.match(button.textContent, /Location freshness: fresh/);
  const search = t.$('input[type=search]'); search.focus(); t.type(search, 'pu'); assert.equal(t.document.activeElement, search, 'typing keeps focus in the search box');
  const select = t.$('[data-filter=readiness]'); select.focus(); t.choose(select, 'ready'); assert.equal(t.document.activeElement, select, 'choosing a filter keeps focus on it');
  t.$('[data-id="EQ-002"]').focus();
  t.view.setItems(ITEMS.filter(i => i.id !== 'EQ-002'));
  assert.equal(t.document.activeElement, t.$('.discovery-results'), 'focus stays inside the results, not on the body');
  t.view.destroy();
});

test('error and access-lost states use fixed text, offer retry, and never leave revoked records in the DOM', {skip}, () => {
  const t = setup(); t.view.setItems(ITEMS);
  const bad = t.view.beginRefresh(); t.view.failRefresh(bad, '<img src=x> secret detail');
  assert.equal(t.$('.discovery-state').getAttribute('role'), 'alert');
  assert.match(t.$('.discovery-state').textContent, /Showing the last loaded list, which may be out of date/);
  assert.ok(!t.host.textContent.includes('secret detail')); assert.equal(t.ids().length, 4);
  assert.equal(t.$('[data-action=retry]').hidden, false); t.$('[data-action=retry]').click(); assert.equal(t.calls.retry, 1);
  t.$('[data-id="EQ-003"]').click();
  const lost = t.view.beginRefresh(); t.view.failRefresh(lost, 'denied');
  assert.match(t.$('.discovery-state').textContent, /no longer have access/);
  assert.equal(t.$$('[data-id]').length, 0); assert.equal(t.$$('[data-group]').length, 0);
  assert.ok(!t.host.textContent.includes('Infusion pump')); assert.deepEqual(t.calls.select.at(-1), null);
  // A superseded refresh cannot bring revoked records back.
  const old = t.view.beginRefresh(), fresh = t.view.beginRefresh();
  assert.equal(t.view.finishRefresh(fresh, ITEMS.slice(0, 1)), true); assert.equal(t.view.finishRefresh(old, ITEMS), false);
  assert.deepEqual(t.ids(), ['EQ-001']);
  t.view.destroy();
  const nr = setup({onRetry: undefined}); const f = nr.view.beginRefresh(); nr.view.failRefresh(f, 'unavailable');
  assert.equal(nr.$('[data-action=retry]').hidden, true, 'no retry button without a retry callback'); nr.view.destroy();
});

test('repeated mount and destroy leaves nothing behind and stops all callbacks', {skip}, () => {
  const dom = new jsdom.JSDOM('<!doctype html><body><div id="host"></div></body>'), {document} = dom.window, host = document.getElementById('host');
  const calls = {highlight: [], select: []}, seenIds = new Set();
  for (let round = 0; round < 5; round++) {
    const view = mountDiscovery(host, {document, onHighlight: v => calls.highlight.push(v), onSelect: v => calls.select.push(v)});
    view.setItems(ITEMS);
    const labelled = host.querySelector('section').getAttribute('aria-labelledby'); assert.ok(!seenIds.has(labelled), 'ids are unique per mount'); seenIds.add(labelled);
    host.querySelector('[data-group="infusion"]').click(); host.querySelector('[data-id="EQ-001"]').click();
    const stale = host.querySelector('[data-id="EQ-001"]'), group = host.querySelector('[data-group="infusion"]'), search = host.querySelector('input[type=search]');
    const before = [calls.highlight.length, calls.select.length];
    view.destroy();
    assert.deepEqual(calls.highlight.at(-1), [], 'destroy clears the highlight'); assert.deepEqual(calls.select.at(-1), null, 'destroy clears the selection');
    assert.equal(host.children.length, 0, 'all DOM removed');
    const after = [calls.highlight.length, calls.select.length];
    stale.click(); group.click(); search.value = 'x'; search.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
    view.destroy(); view.setItems(ITEMS);
    assert.deepEqual([calls.highlight.length, calls.select.length], after, 'no callback after destroy'); assert.ok(after[0] >= before[0]);
    assert.equal(host.children.length, 0);
  }
});

test('the list is plain DOM: no WebGL, canvas, network, HTML injection or third-party imports', () => {
  const dir = join(here, '..');
  for (const file of ['model.js', 'component.js']) {
    const source = readFileSync(join(dir, file), 'utf8');
    assert.ok(!/webgl|canvas|fetch\(|XMLHttpRequest|innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|localStorage|sessionStorage/i.test(source), file);
    for (const m of source.matchAll(/^import .* from '([^']+)'/gm)) assert.match(m[1], /^\.\//, `${file} imports ${m[1]}`);
  }
});

// ---- SV-032 repairs: focus is preserved, and an oversized list is reported honestly ----
test('focus follows the control: a focused type group that disappears moves to the nearest remaining group', {skip}, () => {
  const t = setup(); t.view.setItems(ITEMS);
  const groups = () => t.$$('[data-group]').map(b => b.dataset.group);
  assert.deepEqual(groups(), ['incubator', 'infusion', 'monitor']);
  t.$('[data-group="infusion"]').focus();
  t.view.setItems(ITEMS.filter(i => i.equipmentType !== 'infusion'));
  assert.deepEqual(groups(), ['incubator', 'monitor']);
  assert.equal(t.document.activeElement, t.$('[data-group="monitor"]'), 'next group in the old order');
  t.$('[data-group="monitor"]').focus();
  t.view.setItems(ITEMS.filter(i => i.equipmentType === 'incubator'));
  assert.equal(t.document.activeElement, t.$('[data-group="incubator"]'), 'previous group when no later one remains');
  t.$('[data-group="incubator"]').focus();
  t.view.setItems([]);
  assert.equal(t.document.activeElement, t.$('.discovery-results'), 'no group left: the results list, not the page');
  assert.notEqual(t.document.activeElement, t.document.body);
  t.view.destroy();
});

test('a surviving focused result keeps focus when the list is reordered', {skip}, () => {
  const t = setup(); t.view.setItems(ITEMS);
  const button = t.$('[data-id="EQ-001"]'); button.focus();
  t.view.setItems([...ITEMS].reverse());
  assert.deepEqual(t.ids(), ['EQ-004', 'EQ-003', 'EQ-002', 'EQ-001'], 'the list really was reordered');
  assert.equal(t.$('[data-id="EQ-001"]'), button, 'same element'); assert.equal(t.document.activeElement, button);
  const mid = t.$('[data-id="EQ-003"]'); mid.focus();
  t.view.setItems([ITEMS[2], ITEMS[0], ITEMS[3], ITEMS[1]]);
  assert.equal(t.document.activeElement, t.$('[data-id="EQ-003"]'));
  t.$('[data-group="monitor"]').focus();
  t.view.setItems([...ITEMS].reverse());
  assert.equal(t.document.activeElement, t.$('[data-group="monitor"]'), 'a focused group survives a reorder too');
  t.view.destroy();
});

test('a refresh never steals focus from the search box, a filter, or the clear button', {skip}, () => {
  const t = setup(); t.view.setItems(ITEMS);
  for (const control of [t.$('input[type=search]'), t.$('[data-filter=location]'), t.$('[data-action=clear]')]) {
    control.focus();
    t.view.setItems([...ITEMS].reverse());
    t.view.setItems(ITEMS.filter(i => i.equipmentType !== 'infusion'));
    assert.equal(t.document.activeElement, control, control.outerHTML.slice(0, 30));
    t.view.setItems(ITEMS);
  }
  // Focus outside the component is left alone.
  const outside = t.document.createElement('button'); t.document.body.append(outside); outside.focus();
  t.view.setItems([...ITEMS].reverse()); assert.equal(t.document.activeElement, outside);
  t.view.destroy();
});

test('selection and highlight semantics survive the focus repair', {skip}, () => {
  const t = setup(); t.view.setItems(ITEMS);
  t.$('[data-group="infusion"]').click(); t.$('[data-id="EQ-001"]').click();
  assert.deepEqual([t.calls.highlight.at(-1), t.calls.select.at(-1)], [['EQ-002', 'EQ-003'], 'EQ-001']);
  t.view.setItems([...ITEMS].reverse());
  assert.equal(t.$('[data-group="infusion"]').getAttribute('aria-pressed'), 'true'); assert.equal(t.$('[data-id="EQ-001"]').getAttribute('aria-pressed'), 'true');
  const lost = t.view.beginRefresh(); t.view.failRefresh(lost, 'denied');
  assert.equal(t.$$('[data-id]').length, 0); assert.deepEqual([t.calls.highlight.at(-1), t.calls.select.at(-1)], [[], null]);
  assert.equal(t.view.finishRefresh(lost, ITEMS), false, 'a late success after denial brings nothing back');
  assert.equal(t.$$('[data-id]').length, 0); assert.ok(!t.host.textContent.includes('Infusion pump'));
  t.view.destroy();
});

test('an oversized list shows an honest error, never a complete-looking list or a false "no match"', {skip}, () => {
  const t = setup();
  const make = n => Array.from({length: n}, (_, i) => ({id: `E${i}`, label: `Item ${i}`, equipmentType: 'pump', locationId: 'store', readiness: 'ready', freshness: 'fresh'}));
  t.view.setItems(ITEMS);
  t.view.setItems(make(5001));
  assert.match(t.$('.discovery-state').textContent, /too large to show safely/i); assert.match(t.$('.discovery-state').textContent, /5000/);
  assert.equal(t.$('.discovery-state').getAttribute('role'), 'alert'); assert.ok(!/no equipment matches/i.test(t.$('.discovery-state').textContent));
  assert.match(t.$('.discovery-state').textContent, /last loaded list, which may be out of date/);
  assert.equal(t.ids().length, 4, 'only the previously loaded list is shown, flagged');
  assert.ok(!t.host.textContent.includes('Item 5000'));
  t.view.setItems(make(5000));
  assert.equal(t.$('.discovery-state').hidden, true); assert.match(t.$('.discovery-summary').textContent, /^5000 of 5000 items match/);
  t.view.destroy();
});
