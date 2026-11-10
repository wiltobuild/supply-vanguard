// Deterministic tests for the benchmark runner (SV-028). No network, server, database, token or real clock is used.
// Run: node --test tools/benchmarks/tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {runBenchmark,validateConfig,percentile,formatText,createFetchTransport,LIMITS,NOT_RUN} from '../runner.mjs';
import {parseArgs,resolveConfig} from '../cli.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const base = (extra = {}) => ({baseUrl: 'https://bench.example.test', endpoints: [{name: 'list', path: '/organizations/o1/equipment'}], samples: 5, ...extra});
const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeClock() {
  let t = 0, id = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) { const h = ++id; timers.set(h, {at: t + ms, fn}); return h; },
    clearTimer(h) { timers.delete(h); },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = Math.max(t, due[1].at); due[1].fn();
      }
      t = target;
    },
    pending: () => timers.size,
  };
}
// Runs a benchmark whose transport never answers by moving the fake clock forward until it finishes.
async function drive(promise, clock, step) {
  let done = false;
  promise.finally(() => { done = true; });
  while (!done) { await tick(); clock.advance(step); }
  return promise;
}
// Transport whose latency (in fake milliseconds) and status come from a script.
const scripted = (clock, script) => { const calls = []; const fn = req => { const step = script(calls.length, req); calls.push(req); clock.advance(step.latency ?? 0); return Promise.resolve({status: step.status ?? 200}); }; fn.calls = calls; return fn; };

test('validation rejects unsafe or unbounded settings before any transport call', async () => {
  const bad = [
    [null, /object/], [{...base(), extra: 1}, /Unknown setting/],
    [base({baseUrl: 'ftp://x.test'}), /http or https/], [base({baseUrl: 'https://user:pw@x.test'}), /credentials/],
    [base({baseUrl: 'https://x.test/api'}), /origin only/], [base({baseUrl: 'nope'}), /absolute/],
    [base({endpoints: []}), /explicit entries/], [base({endpoints: [{name: 'a', path: '/x', method: 'POST'}]}), /only GET/],
    [base({endpoints: [{name: 'a', path: '/x', method: 'get'}]}), /only GET/], [base({endpoints: [{name: 'a', path: '/x', body: 'x'}]}), /unknown setting/],
    [base({endpoints: [{name: 'a', path: '//evil.test/x'}]}), /single/], [base({endpoints: [{name: 'a', path: 'https://evil.test/x'}]}), /single/],
    [base({endpoints: [{name: 'a', path: '/a/../b'}]}), /\.\./], [base({endpoints: [{name: 'a', path: '/a\\b'}]}), /backslash/],
    [base({endpoints: [{name: 'a', path: '/a#frag'}]}), /fragment/], [base({endpoints: [{name: 'a', path: '/a b'}]}), /spaces/],
    [base({endpoints: [{name: 'a', path: '/x'}, {name: 'a', path: '/y'}]}), /duplicate/], [base({endpoints: [{name: 'bad name', path: '/x'}]}), /name/],
    [base({samples: 0}), /samples/], [base({samples: LIMITS.maxSamples + 1}), /samples/], [base({samples: 1.5}), /samples/],
    [base({warmup: -1}), /warmup/], [base({concurrency: 0}), /concurrency/], [base({concurrency: LIMITS.maxConcurrency + 1}), /concurrency/],
    [base({timeoutMs: 0}), /timeoutMs/], [base({timeoutMs: LIMITS.maxTimeoutMs + 1}), /timeoutMs/],
    [base({samples: 600, warmup: 100, maxRequests: 500}), /exceeds maxRequests/], [base({maxRequests: LIMITS.maxRequestsCeiling + 1}), /maxRequests/],
    [base({labels: {revision: 'token=abc123'}}), /label revision/], [base({labels: {other: 'x'}}), /Unknown label/],
    [base({headers: {'bad name': 'x'}}), /header name/], [base({headers: {authorization: 'a\r\nb: c'}}), /header value/],
  ];
  let calls = 0;
  const transport = () => { calls++; return Promise.resolve({status: 200}); };
  for (const [config, pattern] of bad) await assert.rejects(runBenchmark(config, {transport, clock: fakeClock()}), pattern, JSON.stringify(config));
  assert.equal(calls, 0, 'transport must not be reached by an invalid config');
  await assert.rejects(runBenchmark(base(), {clock: fakeClock()}), /transport/);
});

test('a valid config is normalized with defaults and bounded workload', () => {
  const cfg = validateConfig(base());
  assert.equal(cfg.origin, 'https://bench.example.test');
  assert.equal(cfg.warmup, 0); assert.equal(cfg.concurrency, 1); assert.equal(cfg.timeoutMs, LIMITS.defaultTimeoutMs);
  assert.equal(cfg.endpoints[0].url, 'https://bench.example.test/organizations/o1/equipment');
  assert.deepEqual(cfg.labels, {revision: 'NOT PROVIDED', environment: 'NOT PROVIDED'});
  assert.throws(() => { cfg.samples = 1; }, TypeError, 'config is frozen');
});

test('percentiles use the nearest-rank method and handle boundaries', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([7], 50), 7); assert.equal(percentile([7], 99), 7);
  assert.equal(percentile([1, 2], 50), 1);            // rank ceil(1) = 1
  assert.equal(percentile([1, 2, 3, 4], 50), 2);      // rank 2
  assert.equal(percentile([1, 2, 3, 4], 51), 3);      // rank ceil(2.04) = 3
  const hundred = Array.from({length: 100}, (_, i) => i + 1);
  assert.equal(percentile(hundred, 50), 50); assert.equal(percentile(hundred, 95), 95);
  assert.equal(percentile(hundred, 99), 99); assert.equal(percentile(hundred, 100), 100);
  assert.equal(percentile([5, 6, 7], 1), 5);
  assert.throws(() => percentile([1], 0), /percentile/); assert.throws(() => percentile([1], 101), /percentile/);
});

test('warmup runs first, is excluded from results and does not leak into percentiles', async () => {
  const clock = fakeClock();
  const transport = scripted(clock, i => ({latency: i < 3 ? 900 : 10 + (i - 3)}));   // 3 slow warmups, then 10..14 ms
  const result = await runBenchmark(base({warmup: 3, samples: 5}), {transport, clock});
  assert.equal(transport.calls.length, 8);
  const e = result.endpoints[0];
  assert.equal(e.warmup.completed, 3); assert.equal(e.measured.completed, 5); assert.equal(e.measured.requested, 5);
  assert.equal(e.latencyMs.max, 14); assert.equal(e.latencyMs.min, 10); assert.equal(e.latencyMs.p50, 12);
  assert.equal(e.status, 'MEASURED'); assert.equal(result.status, 'COMPLETE'); assert.equal(result.failuresPresent, false);
});

test('all warmups across endpoints finish before the first measured request starts', async () => {
  const clock = fakeClock(), order = [];
  const transport = req => { order.push(req.url.endsWith('/a') ? 'a' : 'b'); clock.advance(5); return Promise.resolve({status: 200}); };
  await runBenchmark(base({endpoints: [{name: 'a', path: '/a'}, {name: 'b', path: '/b'}], warmup: 2, samples: 3}), {transport, clock});
  assert.equal(order.length, 10);
  assert.deepEqual(order.slice(0, 4), ['a', 'b', 'a', 'b']);   // warmup round-robin
});

test('errors, redirects and timeouts are counted and never reported as success', async () => {
  const clock = fakeClock();
  const statuses = [200, 500, 302, 404, 99, 200];
  const transport = scripted(clock, i => ({status: statuses[i], latency: 10 * (i + 1)}));
  const result = await runBenchmark(base({samples: 6}), {transport, clock});
  const m = result.endpoints[0].measured;
  assert.equal(m.succeeded, 2); assert.equal(m.errors, 4); assert.equal(m.timeouts, 0); assert.equal(m.completed, 6);
  assert.deepEqual(m.errorClasses, {http_500: 1, redirect_not_followed: 1, http_404: 1, invalid_response: 1});
  assert.equal(result.failuresPresent, true);
  assert.equal(result.endpoints[0].latencyMs.basis, 'successful samples only');
  assert.equal(result.endpoints[0].latencyMs.max, 60);          // only the 200s (10 and 60)
  assert.match(formatText(result), /WARNING: failures or timeouts occurred/);
});

test('a request that never answers times out, is aborted, and its error text is not kept', async () => {
  const clock = fakeClock(), signals = [];
  const transport = ({signal}) => new Promise((_, reject) => { signals.push(signal); signal.addEventListener('abort', () => reject(new Error('Bearer SECRET-TIMEOUT-TEXT'))); });
  const result = await drive(runBenchmark(base({samples: 2, timeoutMs: 250}), {transport, clock}), clock, 250);
  const m = result.endpoints[0].measured;
  assert.equal(m.timeouts, 2); assert.equal(m.succeeded, 0); assert.equal(m.errors, 0);
  assert.ok(signals.every(s => s.aborted), 'timed-out requests are aborted');
  assert.equal(result.endpoints[0].latencyMs.p95, NOT_RUN);
  assert.equal(clock.pending(), 0, 'no timer is left running');
  assert.ok(!JSON.stringify(result).includes('SECRET-TIMEOUT-TEXT'));
});

test('transport failures (thrown or rejected) become a generic class with no message', async () => {
  const clock = fakeClock();
  let n = 0;
  const transport = () => { n++; if (n === 1) throw new Error('https://bench.example.test/?token=LEAK1'); return Promise.reject(new Error('Authorization: Bearer LEAK2')); };
  const result = await runBenchmark(base({samples: 2}), {transport, clock});
  assert.deepEqual(result.endpoints[0].measured.errorClasses, {transport_error: 2});
  const out = JSON.stringify(result) + formatText(result);
  assert.ok(!out.includes('LEAK1') && !out.includes('LEAK2'));
});

test('concurrency never exceeds the configured bound but does reach it', async () => {
  const clock = fakeClock();
  let inflight = 0, peak = 0;
  const transport = async () => { inflight++; peak = Math.max(peak, inflight); await tick(); inflight--; return {status: 200}; };
  const result = await runBenchmark(base({samples: 12, concurrency: 3}), {transport, clock});
  assert.equal(peak, 3); assert.equal(result.endpoints[0].measured.completed, 12);
  inflight = 0; peak = 0;
  await runBenchmark(base({samples: 5, concurrency: 1}), {transport, clock});
  assert.equal(peak, 1);
});

test('cancelling stops new requests, aborts in-flight ones and reports partial or NOT RUN', async () => {
  const clock = fakeClock(), controller = new AbortController(), seen = [];
  let calls = 0;
  const transport = ({signal}) => {
    calls++;
    if (calls === 3) { controller.abort(); }
    return new Promise((resolve, reject) => { seen.push(signal); if (calls <= 2) resolve({status: 200}); else signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  };
  const result = await runBenchmark(base({samples: 10, endpoints: [{name: 'a', path: '/a'}, {name: 'b', path: '/b'}]}), {transport, clock, signal: controller.signal});
  assert.equal(result.status, 'CANCELLED'); assert.equal(calls, 3, 'no request starts after cancellation');
  assert.ok(seen[2].aborted);
  const [a, b] = result.endpoints;
  assert.equal(a.status, 'PARTIAL'); assert.equal(a.measured.completed, 1);
  assert.equal(b.status, 'PARTIAL'); assert.equal(clock.pending(), 0);
  // Cancelled before the start: nothing is sent and every endpoint is NOT RUN.
  const early = new AbortController(); early.abort();
  let sent = 0;
  const none = await runBenchmark(base(), {transport: () => { sent++; return Promise.resolve({status: 200}); }, clock, signal: early.signal});
  assert.equal(sent, 0); assert.equal(none.status, 'CANCELLED'); assert.equal(none.endpoints[0].status, NOT_RUN);
});

test('missing measurements are labeled NOT RUN and default labels say NOT PROVIDED', async () => {
  const clock = fakeClock();
  const result = await runBenchmark(base({samples: 2}), {transport: scripted(clock, () => ({status: 503})), clock});
  const e = result.endpoints[0];
  assert.equal(e.measured.succeeded, 0); assert.equal(e.status, 'MEASURED');
  assert.deepEqual([e.latencyMs.p50, e.latencyMs.p95, e.latencyMs.p99, e.latencyMs.min, e.latencyMs.max], Array(5).fill(NOT_RUN));
  assert.equal(result.labels.revision, 'NOT PROVIDED'); assert.equal(result.labels.environment, 'NOT PROVIDED');
  assert.match(formatText(result), /p50 NOT RUN/);
  const labelled = await runBenchmark(base({labels: {revision: 'main 80a9041', environment: 'local-synthetic'}}), {transport: scripted(clock, () => ({})), clock});
  assert.deepEqual(labelled.labels, {revision: 'main 80a9041', environment: 'local-synthetic'});
});

test('secrets in query values, headers, response bodies and errors never reach the output', async () => {
  const clock = fakeClock(), received = [];
  const transport = req => { received.push(req); clock.advance(4); return Promise.resolve({status: 200, body: 'RESPONSE-BODY-SECRET', headers: {'set-cookie': 'COOKIE-SECRET'}}); };
  const config = base({
    endpoints: [{name: 'q', path: '/organizations/o1/equipment?token=QUERY-SECRET&limit=5'}],
    headers: {authorization: 'Bearer HEADER-SECRET'}, labels: {revision: 'abc1234', environment: 'local'}, samples: 2,
  });
  const result = await runBenchmark(config, {transport, clock});
  assert.equal(received[0].url, 'https://bench.example.test/organizations/o1/equipment?token=QUERY-SECRET&limit=5', 'the transport still gets the real request');
  assert.equal(received[0].headers.authorization, 'Bearer HEADER-SECRET'); assert.equal(received[0].method, 'GET');
  assert.equal(result.endpoints[0].path, '/organizations/o1/equipment?token=[redacted]&limit=[redacted]');
  const out = JSON.stringify(result) + formatText(result);
  for (const secret of ['QUERY-SECRET', 'HEADER-SECRET', 'RESPONSE-BODY-SECRET', 'COOKIE-SECRET', 'authorization']) assert.ok(!out.includes(secret), secret);
});

test('the fetch transport sends GET only, never follows redirects and never reads the body', async () => {
  let init, cancelled = 0;
  const fakeFetch = async (url, options) => {
    init = {url, ...options};
    return {status: 302, get body() { return {cancel: async () => { cancelled++; }}; }, text() { throw new Error('body read'); }, json() { throw new Error('body read'); }};
  };
  const controller = new AbortController();
  const res = await createFetchTransport(fakeFetch)({url: 'https://bench.example.test/x', headers: {a: 'b'}, signal: controller.signal});
  assert.deepEqual(res, {status: 302});
  assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.signal, controller.signal); assert.equal(cancelled, 1);
  const clock = fakeClock();
  const result = await runBenchmark(base({samples: 1}), {transport: createFetchTransport(fakeFetch), clock});
  assert.deepEqual(result.endpoints[0].measured.errorClasses, {redirect_not_followed: 1});
});

test('command line helpers validate arguments and keep secrets out of messages', () => {
  assert.deepEqual(parseArgs(['--config', 'c.json']), {format: 'text', config: 'c.json'});
  assert.equal(parseArgs(['--config', 'c.json', '--format', 'json']).format, 'json');
  assert.throws(() => parseArgs([]), /--config is required/); assert.throws(() => parseArgs(['--config', 'c', '--format', 'xml']), /format/);
  assert.throws(() => parseArgs(['--config', 'c', '--method', 'POST']), /Unknown argument/);
  const file = {baseUrl: 'https://x.test', endpoints: [], headerEnv: {authorization: 'SV_BENCH_AUTH'}};
  const resolved = resolveConfig(file, {SV_BENCH_AUTH: 'VALUE-1'});
  assert.deepEqual(resolved.headers, {authorization: 'VALUE-1'}); assert.ok(!('headerEnv' in resolved));
  assert.throws(() => resolveConfig(file, {}), error => /SV_BENCH_AUTH is not set/.test(error.message));
  assert.throws(() => resolveConfig({headerEnv: {a: 'lowercase'}}, {lowercase: 'SECRET-V'}), error => /environment variable names/.test(error.message) && !error.message.includes('SECRET-V'));
});

test('sources use only built-in Node modules and stay inside this directory', () => {
  const dir = join(here, '..');
  for (const file of readdirSync(dir).filter(f => f.endsWith('.mjs'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const m of source.matchAll(/^import .* from '([^']+)'/gm)) assert.match(m[1], /^(node:|\.\/)/, `${file} imports ${m[1]}`);
    assert.ok(!/XMLHttpRequest|require\(|eval\(/.test(source), file);
  }
});
