// Mutation inventory for the discovery module (SV-032). NOT a test and not part of any suite: run it by hand.
//   node apps/web/discovery/tests/mutation-check.mjs
// It breaks the module on purpose, one change at a time, runs the discovery tests, and reports whether they noticed.
// A mutation that no test catches is a gap in the tests (exit 1). Files are restored afterwards and verified byte for byte.
// Needs jsdom to be findable by the DOM tests; otherwise the component mutations cannot be caught, and the script says so.
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tests = readdirSync(join(root, 'tests')).filter(f => f.endsWith('.test.mjs')).map(f => join(root, 'tests', f));
const MUTATIONS = [
  ['model.js', 'revoked selection is kept', "if (selectedId !== null && !byId.has(selectedId)) setSelected(null);", ''],
  ['model.js', 'highlight survives a search change', 'query = text(value, LIMITS.maxQuery); clearHighlight();', 'query = text(value, LIMITS.maxQuery);'],
  ['model.js', 'unknown items dropped from the counts', 'for (const item of items) counts[locationState(item)]++;', "for (const item of items) if (locationState(item) !== 'unknown') counts[locationState(item)]++;"],
  ['model.js', 'access loss keeps the records', "if (errorCode === 'denied') { load([]);", 'if (false) { load([]);'],
  ['model.js', 'location filter reads freshness', "(name === 'location' ? item.locationId : item[name])", "(name === 'location' ? item.freshness : item[name])"],
  ['model.js', 'duplicate IDs are kept', 'if (item && !seen.has(item.id))', 'if (item)'],
  ['model.js', 'destroy does not clear the highlight', 'clearHighlight(); setSelected(null);\n      destroyed = true;', 'destroyed = true;'],
  ['model.js', 'finishRefresh does not consume its token', '      pendingToken = null;\n      if (Array.isArray(rawItems)', '      if (Array.isArray(rawItems)'],
  ['model.js', 'failRefresh does not consume its token', '      pendingToken = null;\n      return settleFailure(code);', '      return settleFailure(code);'],
  ['model.js', 'pending token set after subscribers are told', '      pendingToken = token; refreshing = true;\n      changed();', '      refreshing = true;\n      changed();\n      pendingToken = token;'],
  ['model.js', 'oversized input is silently truncated', "if (Array.isArray(rawItems) && rawItems.length > LIMITS.maxItems) return settleFailure('too_large');", 'if (Array.isArray(rawItems) && rawItems.length > LIMITS.maxItems) rawItems = rawItems.slice(0, LIMITS.maxItems);'],
  ['model.js', 'size bound is off by one', 'rawItems.length > LIMITS.maxItems', 'rawItems.length >= LIMITS.maxItems'],
  ['component.js', 'labels are written as HTML', "if (k === 'text') node.textContent = v;", "if (k === 'text') node.innerHTML = v;"],
  ['component.js', 'focus is lost when the focused result is removed', '} else if (lostFocus) list.focus();', '}'],
  ['component.js', 'DOM is left behind after destroy', '      root.remove();\n    },', '    },'],
  ['component.js', 'focus is lost when a focused control is reordered', 'if (focused && root.contains(focused)) { if (doc.activeElement !== focused) focused.focus(); }', 'if (focused && root.contains(focused)) { }'],
  ['component.js', 'no fallback when a focused group disappears', 'const target = oldGroupOrder.slice(at + 1).find(keep) ?? oldGroupOrder.slice(0, at).reverse().find(keep);', 'const target = undefined;'],
  ['component.js', 'a refresh steals focus to the search box', 'if (focused && root.contains(focused)) {', 'search.focus(); if (focused && root.contains(focused)) {'],
  ['component.js', 'the oversized state has no message of its own', "else if (s.phase === 'error' && s.errorCode === 'too_large') message =", 'else if (false) message ='],
];
const run = () => spawnSync(process.execPath, ['--test', ...tests], {encoding: 'utf8'});
const count = (out, key) => Number((new RegExp(`^ℹ ${key} (\\d+)`, 'm').exec(out) || [])[1] ?? NaN);

const originals = new Map();
for (const file of new Set(MUTATIONS.map(m => m[0]))) originals.set(file, readFileSync(join(root, file), 'utf8'));
const baseline = run();
console.log(`baseline: ${count(baseline.stdout, 'pass')} pass, ${count(baseline.stdout, 'fail')} fail, ${count(baseline.stdout, 'skipped')} skipped`);
if (count(baseline.stdout, 'fail') !== 0) { console.error('The tests must pass before mutating. Stopping.'); process.exit(2); }
const skippedDom = count(baseline.stdout, 'skipped') > 0;
if (skippedDom) console.log('NOTE: some tests were skipped (no jsdom). Component mutations cannot be caught and will be reported as survivors.');
let survivors = 0;
try {
  for (const [file, name, from, to] of MUTATIONS) {
    const text = originals.get(file);
    if (!text.includes(from)) { console.log(`NOT APPLICABLE  ${name}  (source text changed: update this inventory)`); survivors++; continue; }
    writeFileSync(join(root, file), text.replace(from, to));
    const out = run();
    writeFileSync(join(root, file), text);
    const failed = count(out.stdout, 'fail');
    const caught = failed > 0 || out.status !== 0;
    if (!caught) survivors++;
    console.log(`${caught ? 'caught  ' : 'SURVIVED'}  ${name}  (${Number.isNaN(failed) ? 'would not run' : failed + ' failing'})`);
  }
} finally {
  for (const [file, text] of originals) writeFileSync(join(root, file), text);
}
for (const [file, text] of originals) if (readFileSync(join(root, file), 'utf8') !== text) { console.error(`NOT RESTORED: ${file}`); process.exit(3); }
console.log(`${MUTATIONS.length - survivors} of ${MUTATIONS.length} mutations caught; files restored.`);
process.exit(survivors ? 1 : 0);
